# Operating a local journal

The SQLite adapter coordinates processes on one host using one database on local
disk. The memory adapter is for tests. Neither provides replicated storage,
automatic failover or an availability SLA.

## Keep synchronous work off a latency-sensitive event loop

`SqliteStore` uses Node's synchronous SQLite API. A lock wait, storage read,
serialization or commit occupies its JavaScript thread. Wrapping the call in an
`async` function or awaiting it does not move that work to another thread.

The busy timeout is configured to 5,000 ms. It controls SQLite's lock retry policy,
not the total duration of a Journal call. Scheduling, other database work and
serialization add time. The [runtime experiment](runtime-performance.md) measures
the actual call and timer delay separately from this configuration.

Where the main event loop must remain responsive, give a worker thread or child
process ownership of the store and send it commands through a bounded queue.
Keep a connection in its owner; do not attempt to transfer a live DatabaseSync.
Account for queue delay when selecting lease durations and renewing ownership.
The package supplies a synchronous Store contract, not a worker RPC service.
Timing out an RPC wait does not cancel a command that worker has already accepted.

In v0.3, a completed receipt can be replayed from a committed snapshot while a WAL
writer is active. This avoids that writer lock; the read remains synchronous and
can fail. A snapshot of an absent or pending operation never permits execution.
Only `begin` returning `acquired` supplies that permission. The optional `read`
method is not an offline forensic opener: constructing a SqliteStore can still
create a new database or migrate a v1 database.

## Distinguish application ownership from storage contention

| Observation | Meaning and response |
| --- | --- |
| `begin` returns `busy` | The committed operation has an unexpired owner. Do not invoke the tool. |
| SQLite reports `SQLITE_BUSY` while opening or beginning | The database could not obtain the required lock. No new lease was returned. Keep the same logical identity and apply a bounded retry policy; repeated contention needs diagnosis. |
| `complete` fails in storage | The external action may already have committed. Retain its receipt and investigate; a failed journal write does not undo that action. |
| `complete` returns `stale` | This lease no longer owns completion. It is not evidence that the external action did not happen. |
| `begin` returns `indeterminate` | Automatic recovery has insufficient authority. Quiesce old executors and reconcile against the downstream before using `settle`. |
| A record or schema is rejected | Preserve the database and diagnose the cause. Creating an empty replacement would forget receipts and retry cutoffs. |
| An AggregateError includes a rollback failure | The adapter closes that connection. Inspect the original failure and cleanup failures before opening another one. |

Report the operation stage and a sanitized error code. Avoid logging raw receipts,
input, credentials or database contents. The library authenticates neither callers
nor database files; filesystem access is part of the deployment boundary.

## Back up a consistent and sufficiently recent state

Before changing storage versions, stop old executors and background retries. Use
[SQLite's backup facilities](https://sqlite.org/backup.html) or a clean shutdown
of every connection. With WAL active, copying only the main database can omit
committed data. Preserve the matching application version and configuration.

A consistent snapshot can still be too old to resume execution safely. Actions
completed after that snapshot may be missing from it. Restoring an absent record
makes its key appear new, and a downstream provider may already have discarded
its corresponding idempotency key. The restored journal cannot detect this gap.

Restore into an isolated location with executors stopped. Verify structural
integrity, version compatibility and the snapshot's operational cutoff; reconcile
effects since that cutoff using authoritative downstream records. Resume only
after accounting for that interval. A successful replay of receipts that exist in
the backup does not prove that no receipts are missing. Do not manufacture new
keys or reset retry windows to bypass uncertainty.

Protect the configured database path: opening a missing path intentionally creates
a new journal. A typo, deleted volume or empty mount must be treated as a deployment
failure when an existing journal was expected. The package cannot infer whether a
new path is an intended first launch or accidental loss of the old file.

If both journal tables are absent, initialization requires an empty schema and
SQLite's `schema_version` counter to be zero. A database with unrelated schema
objects or retained schema history is rejected without rebuilding journal tables
or granting a new lease. Existing schema contents and user rows are preserved;
opening still configures SQLite and is not a forensic, read-only operation.
Do not delete schema objects or reset the counter to get past this rejection.
The counter is not authentication: an external reset, replacement with an empty
file, or a consistent but overly old backup can hide the history that is missing.
Keep executors stopped and follow the reconciliation procedure above.

## Limits of the evidence

Process termination, SQLite reopen, synthetic failures and CI checks exercise
specific boundaries. They do not establish power-loss durability on arbitrary
hardware, provider cancellation, cross-host fencing or a production service level.
Operational measurements need the recorded host, workload and software context;
one local run is not a capacity plan for another deployment.
