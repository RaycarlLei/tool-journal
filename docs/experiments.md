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

## Reproduce

Run `npm run benchmark`. It executes four strategies at three kill points, repeated
five times: 60 cases and 120 child-process launches. Each case has fresh journal
and downstream SQLite files. Every pause is acknowledged over IPC, then the parent
terminates that child before starting recovery.

Kill points: before the effect, after committing the effect, and after recording
completion. The clock is logical: acquisition at 100 ms, lease expiry at 110 ms,
recovery at 111 ms. No actual ten-millisecond timing claim is made. POSIX uses
SIGKILL; Node forcefully terminates the process on Windows.

The baselines are small implementations included in [worker.ts](../tests/fixtures/worker.ts):
naive retry has no completion record; checkpoint records completion only; journal
uses the library with either a key-deduplicating downstream or manual recovery.
This comparison does not isolate journal performance: the downstream idempotency
contract is an essential additional capability, explicitly shown in the label.

The report counts external effects separately from completed/replayed outcomes.
An indeterminate action is never counted as confirmed success. Five repetitions
check consistency at these controlled boundaries; they are not confidence
intervals or evidence about the frequency of real-world failures. The matrix is
public and deterministic, not a hidden evaluation set.

`artifacts/crash-matrix.json` records each case, runtime/OS, lockfile hash and source
commit. Release assets include the recorded run. CI runs the same matrix and
uploads its report. The independent property test uses seed 20260907 for 1,000
operation histories; counterexamples are shrunk by fast-check when a test fails.
