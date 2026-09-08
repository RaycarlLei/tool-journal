# Failure contract

## Identity and state

The caller assigns `(scope, key)` to one logical action. Its SHA-256 digest is the
downstream idempotency key. The tool name, canonical JSON input and recovery mode
are a separate fingerprint. A stable logical key with changed input is a conflict,
not a new action. The scope is a namespace, not an authorization mechanism.

| Stored state | Condition | `begin` result | Change |
|---|---|---|---|
| absent | valid request | acquired | pending, epoch 1 |
| any | fingerprint mismatch | conflict | none |
| completed | fingerprint matches | replay | none |
| pending | lease has not expired | busy | none |
| pending | expired, downstream idempotent | acquired | next epoch |
| pending | expired, manual recovery | indeterminate | indeterminate |
| indeterminate | fingerprint matches | indeterminate | none |

Only a matching epoch and executor can complete a pending record, and only before
its deadline. A duplicate completion with the same canonical result is replayed;
a different result is a conflict. Settlement requires an indeterminate record and
matching intent. No transition deletes an entry or reuses its key.

## Where uncertainty begins

There are two separate durable resources: the journal and the external effect.
Writing intent cannot atomically commit an unrelated service's mutation. After a
crash, a pending record means either the tool never ran, or it ran without a
recorded receipt. Manual mode deliberately gives the same answer in both cases.
Availability is sacrificed rather than guessing that retry is safe.

Idempotent recovery is a promise made by the integrator: the downstream atomically
deduplicates concurrent requests, rejects changed parameters for an existing key,
and retains both the key and receipt for the full retry horizon. A cache with a
short TTL does not satisfy an indefinitely retained journal. The synthetic ledger
uses a UNIQUE key in a separate SQLite transaction to implement this contract.

An exception from storage authorizes no tool call. A storage exception after a
tool call or from `complete` is an ambiguous outcome: retry the same completion
while valid, then follow the recovery policy. Never assign a new logical key just
because a response was lost.

## Leases are not external locks

The random executor identifier and monotonic epoch prevent an old process from
overwriting the journal after takeover. They cannot stop an already running HTTP
request. Pass a fencing token only to downstream systems that actually validate
it; otherwise rely on their idempotency contract. `renew` must be called before
expiry. An expired lease cannot be resurrected, even if no replacement exists.

`settle` trusts the caller's externally verified receipt. Before settlement, stop
or otherwise quiesce old executors so a late external effect cannot contradict the
receipt. The library cannot prove this precondition. There is no reset/retry API
for manual actions in v0.1.

## Storage and clock assumptions

The SQLite adapter uses WAL, FULL synchronization and `BEGIN IMMEDIATE`. The
linearization point is a successful transaction commit. Transactions contain no
network work. All accesses, including replay, take the writer lock for simplicity;
this is not a high-throughput adapter. Busy lock waits are bounded to five seconds.

Use one database on local disk, with filesystem locking supported by SQLite.
Network filesystems and replicated database copies are unsupported. The memory
adapter has neither process coordination nor crash durability. Records with invalid
field types, unknown fields, impossible state combinations or noncanonical results
throw; they never become a fresh journal. This validates structure, not authenticity:
someone who can rewrite the database can also forge a structurally valid receipt.

Both adapters reject nested transactions and asynchronous callbacks. The callback
must return a `Change` synchronously. Rejection prevents a returned change from being
committed; it cannot cancel arbitrary JavaScript side effects in a misused callback.
If rollback itself fails, SQLite closes that connection and throws an `AggregateError`
preserving the original failure. Open a fresh adapter only after diagnosing the
storage failure. A failed completion still means its external effect may have occurred.

Processes use the same host wall clock by default. Large clock jumps affect
availability and expiry; this is not a distributed lease service. Time is sampled
inside the storage transaction after acquiring its lock. Tests inject time to
reach exact boundaries without sleeps. Power failure, hardware loss and arbitrary
disk corruption are outside the process-kill experiment.

Input fingerprints are retained instead of raw tool input. Results are stored as
plaintext JSON. Hashes can reveal low-entropy input through guessing. Protect the
database and choose result contents accordingly. v0.1 performs no authentication,
encryption, retention cleanup or secure erasure.

Canonical JSON sorts object keys, preserves array order and rejects unsupported
values, accessors, proxies, sparse arrays and cycles. Negative zero normalizes to zero.
Depth is limited to 64 and encoded size to 1 MiB. Encoding stops as the byte budget
is consumed, including when a small shared object graph would expand exponentially.
Persisted receipts must meet the same domain and canonical encoding. The outer
record has a separate size bound because the nested JSON string escapes again.
These checks do not replace request limits: the caller has already allocated the
input object, and this synchronous API is not a sandbox for arbitrary JavaScript.
