# Measuring SQLite runtime costs

Run `npm run benchmark:runtime` from a source checkout. The command builds the
benchmark, creates its own temporary SQLite databases, and writes raw samples to
`artifacts/runtime-cost.json`. It accepts no database path or other arguments.
There is no provider, model, network request, or external effect. Core runtime
dependencies remain empty.

This is a small, closed-loop API microbenchmark. It measures elapsed time with
`performance.now()`; the existing crash matrix uses logical clocks to test
correctness and is not a throughput measurement. Neither produces a performance
score, capacity guarantee, or CI speed threshold.

## Work and timing

| Workload | Processes sharing one database | Measured operations in total | Warmup operations in total |
| --- | --- | ---: | ---: |
| Independent keys: `begin` then `complete` | 1, then 4 | 1,000 per configuration | 100 per configuration |
| One completed receipt: `begin` returns replay | 1, then 4 | 2,000 per configuration | 200 per configuration |
| Another process holds a write transaction | One caller and one holder | One call per target and hold duration | Completed receipt seeded before timing |

Every worker opens its connection and warms up before sending `ready`. The parent
broadcasts `start` only after all workers are ready. A measured execution contains
two journal transactions; a replay contains one public `begin` call. Inputs and
receipts are fixed small synthetic objects. Payloads are not included in output.

Per-operation timing includes the public API, small intent construction and
outcome checks. It excludes process startup, imports, database creation, warmup,
IPC startup, and closing. The aggregate batch interval runs from the parent's
start broadcast until all result messages arrive, so its rate includes IPC and
the final result transfer. Workers also report their individual batch durations.
Do not compare execution and replay as if they performed equal work.

The file retains each request's latency, outcome and error, including timeouts.
It records n, p50, p95, p99, max, errors, and process CPU time. Quantiles use nearest
rank, without interpolation or discarding long tails. Durations are rounded to
0.001 ms when serialized; this formatting is not a claim of microsecond accuracy.
CPU accounting covers the process, including other threads, and may have coarse
platform granularity. Small batches can be strongly affected by timers, JIT, GC,
IPC, OS scheduling and background load.

## Held writer and the event loop

An independent child executes `BEGIN IMMEDIATE`, then sends `locked`. Only after
that rendezvous does the caller invoke the journal. Each target has a fresh
fixture: replay an existing completed receipt, or begin a new key. Each is measured
once with a 250 ms hold and once with a 6,000 ms hold. The holder performs no row
changes. It reports its actual hold duration and waits for an ACK before closing.

A timer is scheduled immediately before the synchronous call. Its callback delay
shows how that individual call affects its event loop. Twenty idle timers provide
a local baseline; the benchmark does not mislabel a tight batch loop as an
individual API stall. The completed-read result is observed, not fixed: an
implementation with a committed-read fast path may replay while the writer still
holds its reservation. The new-key target preserves the write-contention control.
After release, the caller verifies that the connection can still replay.

The configured SQLite busy timeout is **5,000 ms, not a strict API wall-clock
upper bound**. Scheduling, timer granularity and SQLite's waiting behavior can
affect elapsed time; the benchmark does not separate those contributions. Each
report retains its observed timing and environment. A timeout says the journal
operation failed to obtain the lock, not that unrelated remote work was canceled.

Journal calls are synchronous, including completed replay. A read fast path can
avoid a writer reservation but does not make deserialization or SQLite reads
asynchronous. `await journal.begin(...)` still runs the call synchronously before
awaiting its result. Applications that need a responsive HTTP or agent event loop
should isolate synchronous database work in a dedicated worker or process and
define queue limits and failure handling there. Isolation can improve responsiveness;
it does not create additional SQLite write concurrency or cancel in-flight work.

There is only one long-hold sample per target. For n=1, p50/p95/p99/max are the same
observation, not estimates of rare-event probability. The default run includes
two six-second holds; storage and scheduling can extend it substantially. Each child has
a 90-second health deadline; the full fixture has a 240-second deadline. The
worker helper accepts test deadlines up to 120 seconds. These bounds allow slow
CI machines to perform the original FULL-durability workload; they bound a stalled run
and are not performance pass thresholds. The CI job retains its 10-minute limit.
Worker and fixture expiry report `ERR_RUNTIME_WORKER_DEADLINE` and
`ERR_RUNTIME_FIXTURE_DEADLINE`, respectively, without serializing local paths.
These timers also need an event-loop turn and cannot interrupt a synchronous
native call in the parent. On failure, children are killed and their process/IPC
handles are awaited before deleting the verified temporary directory. There is
no early successful exit when a child fails or stops responding.

## Storage, provenance and interpretation

An anchor connection stays open while DB, WAL and SHM file lengths are collected
before and after the measured work. Lengths are collected again after all
connections close. The output includes net growth. WAL checkpointing can reuse
space: file length is not cumulative bytes written or write amplification. A
different checkpoint position can change DB length before close without changing
the final database size. This benchmark does not measure physical I/O or fsync
latency, so it cannot attribute a bottleneck to disk bandwidth or device latency.

Output includes source commit, dirty status, dependency-lock hash, hashes of the
compiled library and harness, Node/SQLite versions, CPU/OS information and SQLite
settings. It excludes hostname, personal paths, database locations, and result
payloads. The run rejects a changed build or changed source metadata. A dirty run
remains labeled dirty and is not evidence for an exact release commit.

Use at least five independent runs for a public before/after comparison. Keep
aggregate work, payloads, durability settings and table sizes equal; randomize and
record configuration order outside this fixed-order pilot. State warm/cold cache
policy and storage type. Publish every run and raw sample, including errors and
per-worker tails. Do not select the fastest run or infer service capacity under an
open arrival process. Add profiling and actual I/O evidence before assigning CPU
or disk blame. For a read-path change, retain the held-writer contrast; for worker
isolation, report event-loop delay separately from operation completion time.
