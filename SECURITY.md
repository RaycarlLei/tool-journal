# Security

This package coordinates cooperating local callers. A lease is not an access
control boundary and a scope is not a tenant authorization check. Do not expose
the journal API directly to untrusted clients.

For a suspected vulnerability, use this repository's GitHub private vulnerability
reporting feature when enabled. Do not post credentials, private databases or user
traces in a public issue. Include a minimal synthetic reproduction.

Only the latest 0.1.x release is maintained at this stage. No security audit or
production certification is claimed.
