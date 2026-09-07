# Design decisions

## SQLite before a hosted storage adapter

A reviewer should reproduce a crash without cloud credentials. SQLite also makes
the transaction boundary visible. A synchronous adapter keeps the core small but
blocks the event loop while waiting for a lock; applications needing high request
concurrency should isolate it in a worker or implement a different Store. A Store
must provide atomic synchronous read/modify/write and rollback on an exception.

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

## No expired-entry cleanup yet

Deleting a completed record makes its key executable again. Cleanup therefore
needs an explicit maximum retry horizon and a downstream retention agreement.
v0.1 retains entries indefinitely rather than hiding this policy in a TTL.
