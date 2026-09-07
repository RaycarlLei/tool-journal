# Contributing

Run `npm ci` and `npm run check` on Node.js 24.15+. Include a reproducing sequence
for changes to lease or recovery behavior. For concurrency bugs, a process test
with an explicit rendezvous is more useful than a timing-dependent sleep.

Keep changes bounded. New storage adapters need the same conflict, fencing,
reopen and crash tests as SQLite. Describe any weaker guarantees. Changes to
identity or retention semantics need a migration proposal before implementation.

AI-assisted contributions are welcome. Authors remain responsible for the patch
and must be able to explain it. Do not submit private traces, production endpoints,
credentials or personal data. Synthetic examples should identify themselves.
