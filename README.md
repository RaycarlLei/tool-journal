# tool-journal

A durable execution journal for tools that may be retried after a crash.
TypeScript, SQLite, no runtime dependencies. Requires Node.js 24.15 or later.

The hard case is a tool that **finishes its external action but loses the response**.
A checkpoint cannot tell you whether that action happened. This library records
intent before execution, coordinates leases, and makes uncertainty an explicit
result. Automatic recovery requires a downstream idempotency contract and an
explicit, finite retry admission window.

## Try the failure

```sh
git clone https://github.com/RaycarlLei/tool-journal.git
cd tool-journal
npm ci
npm test
npm run demo
```

The demo kills a real child process after it commits to a separate synthetic
ledger, then starts another process to recover. It compares five approaches:

| Approach | Recovery after the effect, before recording completion |
|---|---|
| Retry without a journal | Repeats the effect |
| Completion checkpoint | Repeats the effect |
| Downstream idempotency alone | Retrieves the original receipt through another call |
| Journal + downstream idempotency | Retrieves the original receipt while retry admission remains open |
| Journal + manual recovery | Stops with `indeterminate` |

Downstream idempotency prevents duplicate effects in both idempotent strategies.
The journal additionally coordinates live execution, detects changed intent and
replays completed receipts without contacting the service. The experiment measures
service calls and effects separately so those benefits are not conflated.

This is a correctness experiment with an injected logical clock, not a throughput
benchmark or a claim about any model's performance. [Protocol and raw results](docs/experiments.md).

Engineering note: [The receipt that did not arrive](docs/lost-receipt.md).

For the same failure over a real loopback HTTP connection, run `npm run demo:http`.
The synthetic service commits to its own SQLite database and closes the socket
before returning a receipt. Idempotent recovery makes two HTTP calls for one
effect, then replays locally; manual recovery keeps the outcome indeterminate
after one call. [Integration code](examples/http/client.ts) handles bounded
responses and an absolute request deadline without hidden transport retries.
The [HTTP tests](tests/http-recovery.test.ts) also reopen both databases and
reject receipts that arrive after lease expiry. This is a local example, not
a hosted service or a production network adapter. Client and service run in one
process; HTTP tests reopen stores normally, while the separate process tests
exercise forced termination. Network deadlines do not include synchronous
SQLite lock waits.

The [LangGraph integration](integrations/langgraph) uses a real `StateGraph` and
the official SQLite checkpointer. Its process-kill tests cover a failed HTTP node
and the gap between journal completion and the next graph checkpoint. The
framework has its own pinned dependencies; the graph imports the installed
library archive through the public API. No model key or external service is needed.

## Use the journal

```ts
import { Journal, SqliteStore } from '@raycarllei/tool-journal';

const store = new SqliteStore('tools.sqlite');
const journal = new Journal(store);
const intent = {
  scope: 'demo-workspace',
  key: 'request-42:append-0', // stable across retries; chosen by your application
  tool: 'append',
  input: { units: 7 },
  recovery: 'idempotent' as const,
  retryForMs: 60_000, // fixed from first acquisition; choose for your downstream contract
};

const begun = journal.begin(intent, 30_000);
if (begun.kind === 'acquired') {
  // downstream.append is YOUR adapter. It must enforce this idempotency key.
  // The journal does not turn a non-idempotent endpoint into an idempotent one.
  const receipt = await downstream.append(intent.input, {
    idempotencyKey: begun.lease.id,
  });
  const completion = journal.complete(begun.lease, receipt);
  // A stale lease must not be presented to the caller as confirmed completion.
  console.log(completion);
} else if (begun.kind === 'replay') {
  console.log(begun.result);
} else {
  console.log(begun); // busy, conflict, or indeterminate: do not invoke the tool
}
store.close();
```

The API example illustrates an integration; `downstream` is not supplied by this
package. The clone-and-run demo above is self-contained. v0.2 is distributed as
source and a release archive; no npm registry publication is assumed.

`begin` binds a scope/key to the tool, canonical input and recovery policy.
Changing any of those or a known retry window under the same key is a conflict. `complete` fences stale
executors; repeating the same completion is harmless. `renew` extends an active
lease. `settle` records an independently verified receipt for an indeterminate
action, **after the caller has stopped old executors**.

For idempotent operations, `retryForMs` is required. The first acquisition fixes
`retryStartBefore`; retries, renewals and restarts cannot extend it. Once admission
has closed, an expired pending operation becomes `indeterminate`. An active lease
can still record its receipt, and a completed receipt remains replayable. Manual
operations have no retry window. See [retry admission and migration](docs/retry-admission.md).

The cutoff governs journal authorization, not arrival at the downstream service.
An executor paused before sending, or a delayed request, can still arrive after a
provider deletes its key. Client timeouts do not establish server-side cancellation.

## Guarantees and limits

- SQLite transactions serialize claims from processes sharing one local database.
- Completed results are replayed without another tool invocation by a cooperating caller.
- An expired manual-recovery action cannot be automatically acquired again.
- An idempotent action cannot be reacquired at or after its fixed admission cutoff.
- Lease generations fence journal writes. They do **not** fence an external service.
- A caller can violate the protocol by executing without a lease, reusing a key
  for another logical action, or falsely declaring the downstream idempotent.
- No cross-service exactly-once guarantee. No database GC, distributed clock,
  scheduler, authentication, model SDK or live trading integration.
- Node's built-in SQLite API is experimental in Node 24; the adapter is synchronous.
  This is a v0.2 reference implementation, not a production SLA.

Read the [failure contract](docs/contract.md) before integrating.

## Read the implementation

1. [State transitions](src/journal.ts): acquisition, expiry, uncertainty, settlement.
2. [Storage transaction](src/sqlite.ts): local durability and serialized claims.
3. [Process tests](tests/process.test.ts): kill points and concurrent contenders.
4. [Independent model](tests/model.test.ts): 500 memory and 40 SQLite histories,
   plus exact-boundary walks through renewal, settlement, conflicts and reopening.
5. [Storage integrity](tests/integrity.test.ts): malformed records, failed rollback,
   bounded JSON and invalid transaction callbacks.

```sh
npm run check           # tests, targeted mutations, public-tree and package checks
npm run benchmark       # 100 controlled cases; writes artifacts/crash-matrix.json
npm pack               # compiled library + docs; no fixtures or local databases
```

The targeted mutation check removes eight safeguards, one at a time, and requires
an assertion failure for each. It is not a whole-project mutation score. The package
check installs the real archive offline in a fresh project, exercises SQLite reopen
through the public exports, and compiles a TypeScript consumer. CI runs on Linux,
Windows and macOS with the minimum supported Node 24 release and Node 26.
The same matrix installs and tests the LangGraph example, including its native
SQLite checkpointer, separately from the dependency-free library.

## Project scope

An independent reference implementation informed by work on TraderBear. It does
not contain TraderBear's production code, private history, customer data, trading
strategies, evaluation bank, or service configuration. It is not represented as
the library currently running TraderBear.

Maintained by [RaycarlLei](https://github.com/RaycarlLei). MIT licensed. AI coding
assistance was used during development; maintainers are responsible for design,
review, tests and claims. [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md).
