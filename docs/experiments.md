# Crash experiment

## Recorded v0.1.0 run

Source: `3eb96ded1b807d92f259ef7ff6d26504cc4bd849`. The local run and the
[Ubuntu/Windows CI runs](https://github.com/RaycarlLei/tool-journal/actions/runs/34153866046)
produced the following counts on Node.js 24.15.0:

| Strategy | Cases | Cases with duplicate effects | Indeterminate | Confirmed |
|---|---:|---:|---:|---:|
| Naive retry | 15 | 10 | 0 | 15 |
| Completion checkpoint | 15 | 5 | 0 | 15 |
| Journal + downstream idempotency | 15 | 0 | 0 | 15 |
| Journal + manual recovery | 15 | 0 | 10 | 5 |

The baseline's "confirmed" count does not imply correctness: a run can return a
receipt after causing a duplicate. The manual strategy has five cases that stop
before any effect and five that stop after one effect; neither group is guessed
to be successful. [Download the local raw matrix](https://github.com/RaycarlLei/tool-journal/releases/download/v0.1.0/crash-matrix.json).

## Current protocol (2)

Run `npm run benchmark`. It executes five strategies at four controlled boundaries,
repeated five times: 100 cases, representing 20 distinct strategy/boundary pairs.
Each case has fresh journal and downstream SQLite files. A process pause is
acknowledged over IPC before the parent terminates the child and starts recovery.

Kill points: before the effect, after committing the effect, and after recording
completion. A fourth case drops the response after the effect, reports the transport
failure, and starts a new recovery process. The clock is logical: acquisition at 100 ms, lease expiry at 110 ms,
recovery at 111 ms. No actual ten-millisecond timing claim is made. POSIX uses
SIGKILL; Node forcefully terminates the process on Windows.

The baselines are small implementations included in [worker.ts](../tests/fixtures/worker.ts):
naive retry has no completion record; checkpoint records completion only;
downstream-idempotency-only passes the same stable action key used by journal-idempotent
but has no journal; journal uses the library with either that downstream contract or
manual recovery. Both idempotent strategies prevent duplicate effects in this fixture.
That property belongs to the downstream contract, not to journal storage alone.

The journal suppresses service calls after completion has been durably recorded.
Separate process tests verify suppression while another executor holds a live lease,
and verify that an old executor can still reach the downstream even though its journal
completion is rejected. Manual uncertainty cannot cancel a request already in flight.

The report counts service calls and external effects separately from completed/replayed outcomes.
An indeterminate action is never counted as confirmed success. Five repetitions
check consistency at these controlled boundaries; they are not confidence
intervals or evidence about the frequency of real-world failures. The matrix is
public and deterministic, not a hidden evaluation set.

`artifacts/crash-matrix.json` records each case, runtime/OS, lockfile hash and source
commit and whether tracked changes were present. Release assets include the recorded
run. CI runs the same matrix and uploads its report. Historical protocol 1 results
above remain tied to the original release and must not be relabeled as protocol 2.

The independent model uses seed 20260908 for 500 MemoryStore histories and 40 SQLite
histories of up to 100 commands. Each adapter also runs a 23-command exact-boundary
walk, and coverage assertions require 26 observable protocol paths. Commands cover
renewal, settlement, input/result mutation, old handles, multiple namespaces,
rollback and connection reopening. fast-check shrinks failing random sequences.
This is bounded model-based testing, not an exhaustive proof of all interleavings.

## HTTP receipt loss

`npm run demo:http` uses a real IPv4 loopback connection and two independent
SQLite files. The service commits its effect, then closes the socket before
response headers. The idempotent example recovers the same receipt on its next
call and replays it locally afterward: two HTTP calls, one effect. The manual
example makes one call and reports uncertainty after lease expiry.

The client makes one attempt with an absolute network deadline, a response-byte
limit and receipt validation. Tests cover malformed and oversized messages,
redirect rejection, expired receipts and reopening both stores. The service and
client share a process in this integration fixture. Reopening is orderly; the
separate process tests above provide the forced-termination evidence. Neither
fixture demonstrates cross-host availability or a production service SLA.
