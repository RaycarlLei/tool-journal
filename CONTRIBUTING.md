# Contributing

Changes affecting integration behavior also need the independently installed
[LangGraph example](integrations/langgraph): run its `npm ci`, `npm test` and
`npm run demo` after installing the root project. The example's native dependencies
belong to its own lockfile; do not move them into the library's runtime manifest.

Run `npm ci` and `npm run check` on Node.js 24.15+. Include a reproducing sequence
for changes to lease or recovery behavior. For concurrency bugs, a process test
with an explicit rendezvous is more useful than a timing-dependent sleep.

`npm run check` also installs the archive into an isolated offline consumer and
type-checks its public API. The model tests print fast-check's seed and shrink path
on failure; include both when reporting a sequence-dependent bug.

The [release guide](docs/releases.md) describes the candidate package produced by
CI and how to reproduce its offline consumer check and source/checksum record.

Keep changes bounded. New storage adapters need the same conflict, fencing,
reopen and crash tests as SQLite. The present Store contract is synchronous;
an asynchronous database needs an API design change, not a cast hiding a Promise.
Describe any weaker guarantees. Changes to
identity or retention semantics need a migration proposal before implementation.

AI-assisted contributions are welcome. Authors remain responsible for the patch
and must be able to explain it. Do not submit private traces, production endpoints,
credentials or personal data. Synthetic examples should identify themselves.
