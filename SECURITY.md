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
loop; the five-second busy timeout is a bound, not an availability guarantee.

For a suspected vulnerability, use this repository's GitHub private vulnerability
reporting feature when enabled. Do not post credentials, private databases or user
traces in a public issue. Include a minimal synthetic reproduction.

Only the latest 0.1.x release is maintained at this stage. No security audit or
production certification is claimed.
