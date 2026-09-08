# A deadline for granting retries

A provider may eventually discard an idempotency key. Retrying the old operation
after that point can create another effect even when the request uses the same key.
tool-journal v0.2 therefore requires an explicit finite window for new retry leases:

```ts
const intent = {
  scope: 'synthetic-example', key: 'append-42', tool: 'append', input: { units: 7 },
  recovery: 'idempotent' as const, retryForMs: 60_000,
};
const begun = journal.begin(intent);
if (begun.kind === 'acquired') console.log(begun.retryStartBefore);
```

The one-minute value is an example, not a recommendation for a real provider.
The first acquisition stores its clock reading and the derived cutoff in the same
transaction. Repeating the operation in another process or graph thread does not
restart the window. Changing `retryForMs` conflicts with the stored policy. A
manual operation omits `retryForMs` entirely.

## Admission and ownership are different

`retryStartBefore` limits when a new execution lease may be issued. The lease's
own deadline limits which executor may record completion. These have different
jobs:

| At or after the admission cutoff | Result |
| --- | --- |
| A completed receipt exists | Replay it locally |
| A pending lease is still active | Return busy; its owner can complete or renew |
| The pending lease has expired | Persist indeterminate; issue no retry lease |
| The operator has independently reconciled an indeterminate action | Allow explicit settlement after old executors are quiescent |

Renewal does not extend admission. A cutoff reached exactly is closed. Once
indeterminate, moving the clock backward does not restore retry permission.

## What the cutoff cannot establish

Suppose a synthetic provider deletes its key at time 100. A retry is authorized at
99, pauses, and arrives at 101. The provider can commit a second effect. The same
problem exists when an old executor wakes up after another executor has finished.
Rejecting a stale journal completion does not undo that external effect. A client
timeout stops waiting; it is not proof of server-side cancellation.

The [regression suite](../tests/retry-window.test.ts) includes both the rejected
post-cutoff acquisition and this delayed-arrival counterexample. The latter is
intentional evidence of a limit, not a claim that the journal prevents it.

Provider contracts differ. [Stripe](https://docs.stripe.com/api/idempotent_requests)
allows keys to be cleaned up after at least 24 hours. [DynamoDB transaction tokens](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)
have a ten-minute window after the first request completes. [PayPal](https://developer.paypal.com/api/rest/reference/idempotency/)
states that storage duration depends on the API. Check the actual endpoint, key
scope, payload binding and retention policy; do not infer them from a generic SDK
retry option.

Anchoring the window at first journal acquisition assumes that the key has never
been used downstream before. A conservative safety margin also needs justified
bounds on delay and clock error. An ordinary HTTP timeout is not a maximum request
arrival time. Stronger external guarantees require the provider to enforce a
deadline/fencing contract or a durable business uniqueness constraint itself.

## Upgrading a v0.1 journal

1. Stop every old executor, including background retries. Reconcile outstanding
   external work where possible. A database upgrade cannot stop an HTTP request.
2. Take a consistent backup using [SQLite's backup facilities](https://sqlite.org/backup.html) or after a clean
   shutdown of all connections. Do not copy only the main file while a WAL writer
   is active. Keep the matching application version and integration configuration.
3. Update idempotent intents to supply a fixed `retryForMs`. Keep scope, key, tool,
   input and recovery mode unchanged. Do not assign a new key to bypass uncertainty.
4. Open the database with v0.2. The adapter validates and re-encodes v1 rows and
   updates schema metadata in one transaction, with bounded memory. A failure rolls back;
   investigate it instead of deleting the journal or creating an empty replacement.
5. Completed legacy records replay. Pending legacy idempotent records have no
   knowable retry window: an active owner can still finish, but after lease expiry
   `begin` returns indeterminate. Use independently verified evidence with `settle`;
   adding `retryForMs` cannot manufacture a fresh window for an old operation.

`firstAcquiredAt`, `retryForMs` and `retryStartBefore` are all null for legacy rows.
The last lease deadline cannot recover the first acquisition time because it may
have been renewed or replaced. Manual recovery is unchanged. A migrated completed
receipt can replay with the new caller's configured window because that historical
window is unknown and replay issues no external request.

v0.1 clients reject schema v2 on opening. SQLite guards also reject their v1-format
writes if they already had a connection open. Mixed-version operation and database
downgrades are unsupported. Custom Store adapters must persist all v2 fields and
provide their own atomic migration; the memory adapter has no durable v1 history.
