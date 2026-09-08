# Changelog

## 0.3.0

- Replay completed receipts through an optional validated Store snapshot. SQLite
  readers no longer need the writer lock for that path; all execution grants
  still read and commit inside the existing write transaction.
- Bound SQLite values before the native wrapper returns them to JavaScript,
  including legacy migration records and identities. Preserve valid UTF-16
  databases and the precise UTF-8 receipt limit. Reject noninteger schema metadata.
- Reuse per-connection read/write statements and expose an independent runtime
  experiment for operation latency, contention, event-loop delay and file growth.
- Document lock errors, worker isolation, backup freshness and safe recovery.
  The SQLite busy timeout is configuration, not a total wall-clock deadline.
- Keep storage schema v2. Existing v0.2 records need no migration; custom stores
  without the optional read method retain their transactional behavior.

## 0.2.0

- Require an explicit finite retry admission window for idempotent operations.
  Persist its first-acquisition anchor; retries, renewal and reopening cannot reset
  the cutoff. Expired ownership after admission closes becomes indeterminate.
- Keep receipt completion and lease renewal independent of retry admission, and
  preserve completed receipt replay after the cutoff.
- Migrate v1 SQLite records atomically without inventing historical timestamps.
  Unknown legacy windows cannot authorize a new retry. Reject old-client writes.
- Document the API/storage migration and test delayed provider arrival as a limit
  of client-side authorization, not an exactly-once guarantee.

## 0.1.2

- Add an independently installed LangGraph integration using the official SQLite
  checkpointer and the library's packaged public API. Process-kill regressions
  distinguish graph checkpoints, journal receipts and downstream effects.
- Check the integration on all supported CI platforms and Node versions while
  keeping framework dependencies outside the library's runtime manifest.
- Scan tracked and untracked public candidates, including force-staged ignored
  files, without traversing installed integration dependencies.
- Declare the Node ambient type environment explicitly and avoid duplicate
  branch-push checks when a pull request is already checked.

## 0.1.1

- Reject malformed persisted recovery policies and noncanonical receipts before
  they can trigger a retry or replay. Validate records before storing them.
- Bound canonical JSON while encoding, including shared-object expansion, and
  reject proxies without invoking their traps.
- Reject nested and asynchronous store callbacks consistently. Preserve the
  primary transaction error when rollback fails and close unusable connections.
- Exercise renewal, settlement, multiple action identities and reopening in
  independent memory and SQLite state models with explicit boundary coverage.
- Add a downstream-idempotency-only control and distinguish calls from effects
  in the 100-case experiment, including response loss without a process kill.
- Demonstrate a real HTTP socket loss after a separate downstream commit, with
  bounded transport handling and manual recovery that preserves uncertainty.
- Check seven targeted mutations and install the actual package in a fresh
  offline consumer, including a public TypeScript API check.
- Run Linux, Windows and macOS checks on Node 24.15 and 26; pin Actions by commit,
  and add dependency updates and issue/review templates.

## 0.1.0

- Intent binding, lease takeover, fenced completion, renewal and explicit manual settlement.
- SQLite and memory adapters with a shared behavioral test suite.
- Real process-kill tests, concurrent acquisition, seeded state histories and four targeted mutations.
- Synthetic crash matrix comparing retries, checkpoints and explicit recovery contracts.
