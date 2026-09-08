# The receipt that did not arrive

The demo in this repository stops a process at an inconvenient line: the ledger
has committed an effect, but the journal has not recorded the receipt. This is a
synthetic experiment, not a report of a TraderBear production incident.

```sh
npm ci
npm run demo
```

The parent waits for an IPC message confirming that the ledger commit finished.
It then kills that process. Recovery happens in a new process with a new database
connection. There is no exception handler left alive to undo or finish the work.

## Why a checkpoint is insufficient

Consider three steps: record intent, call the tool, record completion. The
checkpoint tells us whether step three finished. If it did not, step two might
still have committed. Moving the checkpoint before the call only changes the
failure mode: now a crash between the checkpoint and the call can lose the action.

Our checkpoint baseline therefore repeats the effect at this kill point. The
same baseline recovers correctly when killed after recording completion. Both
observations matter; the experiment does not claim that checkpoints are useless.

## The extra contract that enables retry

The idempotent variant passes the same logical action key to the ledger on every
attempt. The ledger atomically stores that key with the effect and its receipt.
Recovery can ask again without creating another effect. The receipt comes from
the downstream's durable record, not from an LLM reconstructing what probably
happened.

This distinction is why the comparison labels both the journal and downstream
idempotency. A local journal alone cannot provide this property for an arbitrary
remote service. An API whose idempotency keys expire sooner than retries can occur
would also violate the contract.

The current experiment includes downstream idempotency without a journal, using
exactly the same key. It also avoids duplicate effects. The journal adds a durable
local receipt, live-lease coordination and changed-intent detection; after completion
is recorded, replay no longer needs another service call. The original v0.1.0 matrix
did not isolate those responsibilities and is retained as a historical result.

## What an old executor can still do

A lease can expire while a process is paused. A new process then takes over with
a higher epoch. If the old process resumes, its completion is rejected by the
journal. That protects the journal's result, but does not retract a network request
the old process already sent. External fencing only works when the external
resource checks the token. Otherwise, downstream idempotency still does the work.

The library makes those responsibilities visible in its API: `begin` returns an
execution lease, and `complete` can return `stale`. The application must inspect
both. A successful tool response alone does not authorize reporting confirmed
completion for an expired attempt.

## When stopping is the correct result

In manual mode, the recovered process does not know whether the tool ran. It
returns `indeterminate`. This also happens if the first process died just before
the call, even though no effect exists. That conservative false positive is the
cost of avoiding an unsafe retry.

The caller may later verify a downstream receipt, stop old executors and settle
the record. The library cannot establish those facts itself. There is deliberately
no reset button that silently turns uncertainty into permission to execute again.

## What the experiment establishes

The [experiment](experiments.md) covers three chosen kill points and one response-loss
boundary on local SQLite files. It demonstrates the implemented protocol there.
The seeded model tests explore additional operation sequences, and the targeted
mutations verify that selected safeguards are actually tested. None of these
establish a production failure rate, power-loss durability or correctness for an
adapter with a different transaction model. Those would require different tests.
