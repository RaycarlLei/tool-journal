# Security

This package coordinates cooperating local callers. A lease is not an access
control boundary and a scope is not a tenant authorization check. Do not expose
the journal API directly to untrusted clients.

Persisted records are structurally validated before use, including canonical
receipt data and size bounds. Validation does not authenticate the database or
detect a forged but valid record. Protect filesystem access and backups. Results
are plaintext; return only the receipt fields needed for recovery.

The JSON encoder rejects proxies and accessors without invoking them and stops at
its output budget. Callers still need admission control and request/body limits
before parsing untrusted input. A local synchronous lock wait can block the event
loop. SQLite's busy timeout is configured to 5,000 ms; total call duration can
exceed it. Completed receipt reads avoid the writer lock, but remain synchronous.

For a suspected vulnerability, use this repository's GitHub private vulnerability
reporting feature when enabled. Do not post credentials, private databases or user
traces in a public issue. Include a minimal synthetic reproduction.

An admission cutoff limits new journal leases, not the provider's execution time.
Old executors, delayed requests, a reused pre-journal key and an unstable clock can
violate an integrator's retention assumptions. See [retry admission](docs/retry-admission.md).

Only the latest 0.3.x release is maintained at this stage. The v1 database upgrade is
forward-only; stop old executors and back up before migration. No security audit or
production certification is claimed.
