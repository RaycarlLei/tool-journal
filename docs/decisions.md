# Design decisions

## SQLite before a hosted storage adapter

A reviewer should reproduce a crash without cloud credentials. SQLite also makes
the transaction boundary visible. A synchronous adapter keeps the core small but
blocks the event loop while waiting for a lock; applications needing high request
concurrency should isolate it in a worker or implement a different Store. A Store
must provide atomic synchronous read/modify/write and rollback on an exception.

## Read committed receipts without reserving the writer

A completed receipt does not authorize another execution. In v0.3, stores can
provide an atomic validated read snapshot so this path need not acquire the writer
lock. The decision linearizes at that read; all pending, absent and indeterminate
snapshots return to the write transaction and are read again. We do not upgrade a
read transaction or rerun a user callback automatically after lock contention.
Stores without the optional method keep their original transactional behavior.

The SQLite query checks the stored type and byte length before returning a value
to JavaScript. Keeping guards and payload in one SELECT also prevents a writer
from enlarging the row between a size preflight and a later autocommit read.

## A journal instead of an agent framework

Retry identity and uncertain side effects are useful beyond chat agents. The core
does not choose tools, parse prompts or schedule work. Adding an LLM dependency
would not help resolve the crash window. The application owns policy and execution.

## Fingerprint input separately from the logical key

Hashing only arguments merges two intentionally repeated actions. Hashing only a
provider tool-call ID fails when a resumed model generates another ID. The caller
must supply stable intent identity; the input fingerprint then detects conflicting
reuse. Epochs and random execution IDs belong to attempts, not logical actions.

## Unknown is a first-class result

Many retries happen after a timeout, which is evidence about observation rather
than execution. Manual recovery cannot distinguish a lost receipt from a tool that
never started. We accept this false-positive uncertainty. Automatically treating
it as failure would permit duplicate side effects.

## Bound retry admission without discarding a live receipt

Provider key retention is finite. v0.2 records a fixed admission cutoff, while
keeping lease ownership separate so an active executor can record its receipt
after new retries have been barred. We cannot turn that cutoff into a network
arrival guarantee. v1 records have no first-acquisition timestamp; migration must
preserve that absence rather than grant them a new window at upgrade time.

## No expired-entry cleanup yet

Deleting a completed record makes its key executable again. Cleanup therefore
needs an explicit maximum retry horizon and a downstream retention agreement.
v0.2 retains entries even after admission closes. Deleting the record would also
delete its cutoff and permit a new first acquisition under the same key.
