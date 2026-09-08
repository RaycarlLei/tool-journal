# Changelog

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
