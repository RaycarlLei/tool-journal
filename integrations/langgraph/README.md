# LangGraph: recovering a tool receipt

This example runs a real `StateGraph` against a synthetic loopback HTTP service.
The graph uses the official `SqliteSaver`; tool-journal keeps a separate durable
record of each logical tool operation. There is no model call, API key, or trading
integration.

## Run

Requires Node 24.15 or newer. From the repository root:

```sh
npm ci
cd integrations/langgraph
npm ci
npm test
npm run demo
```

The example has its own dependency manifest and lockfile. Its `prepare` script
builds the root project, runs `npm pack`, and installs that archive with
`--no-save --ignore-scripts`. [graph.ts](graph.ts) imports the installed package's
public export. It does not import the implementation through a relative source
path. The root library retains zero runtime dependencies.

The local archive intentionally stays outside the framework lockfile; `prepare`
checks that installing it leaves that lock unchanged. Consequently `npm ls`
labels tool-journal as **extraneous**. Run `npm run prepare` after changing the
root library, or after a command that prunes unlisted packages. No archive or
registry publication is needed in this example's Git history.

`@langchain/langgraph` is pinned to 1.4.14, `@langchain/core` to 1.1.48,
`@langchain/langgraph-checkpoint-sqlite` to 1.0.4, and its native `better-sqlite3`
dependency to 12.10.0. The native dependency supports Node 24 and 26 in its
published engine range. Installation may require a compiler when a matching
prebuilt binary is unavailable. Do not copy `node_modules` between Node majors.

## The boundary that checkpoints leave open

```text
prepare node checkpoint
        |
journal.begin(scope, key, tool, input)
        |
HTTP service commits an effect
        |
HTTP receipt reaches the node
        |
journal.complete(lease, receipt)
        |
append node returns -> LangGraph saves its next checkpoint
```

Three independent files serve different purposes:

| File | Owns | Does not establish |
| --- | --- | --- |
| `graph.sqlite` | LangGraph state, pending nodes, and thread checkpoints | Whether an external service committed its request |
| `journal.sqlite` | Logical operation identity, lease ownership, uncertainty, and a confirmed receipt | A transaction spanning the HTTP service |
| `downstream.sqlite` | Synthetic effects and the downstream idempotency contract | Whether the caller received a response |

The `prepare` node validates the action and clears the prior result. Invocations
use `durability: 'sync'` to persist the graph step before its successor runs. The
`append` node has `retryPolicy: { maxAttempts: 1 }`. A transport error escapes;
the caller decides whether and when to resume the failed node using the same
`thread_id` and `graph.invoke(null, config)`.

The application's `scope` and `key` identify one logical operation. They stay
constant across graph threads, task IDs, checkpoint IDs, and retry attempts.
Changing the units or recovery contract under that identity produces `conflict`
before another HTTP request. A different intended operation needs a different
application key. The graph thread ID remains LangGraph's state identity, not an
HTTP idempotency key.

## What the example and tests demonstrate

The service can close its TCP connection immediately **after** its SQLite commit,
before sending HTTP response headers. In idempotent mode, an explicit retry
after lease expiry sends the same downstream key and recovers the original
receipt. In manual mode, resuming after expiry returns `indeterminate` and makes
no further HTTP request. It never calls `settle` or invents evidence of success.

Expected demo output:

```text
idempotent: failed node -> completed on resume -> replay in a new graph thread
            2 HTTP calls, 1 effect
manual:     failed node -> indeterminate on resume -> still indeterminate
            1 HTTP call, 1 effect
```

[recovery.test.ts](tests/recovery.test.ts) also kills actual child processes at
two boundaries: after a lost response fails the node, and after a receipt is
committed to the journal but before that node returns to LangGraph. The HTTP
service stays alive in the parent process. A new graph runtime opens the official
SQLite checkpoints and resumes the pending node. In the second case, the saved
graph state still has no outcome; tool-journal supplies the receipt without a
second HTTP call. Both boundaries are tested for idempotent and manual actions.

A new graph thread deliberately executes the tool node again in the replay test.
This distinguishes journal replay from LangGraph simply returning an already
completed graph checkpoint. Other regressions cover changed intent, independent
graph threads competing for one operation, and manual recovery before and after
lease expiry.

## Limits

- The demo uses normal close/reopen; the tests additionally use OS process kills.
  They do not simulate power loss, disk failure, or a remote provider's behavior.
- `SqliteSaver` is the official local SQLite checkpointer, not a multi-host or
  highly available checkpoint service. One caller owns an active graph thread;
  do not concurrently invoke the same thread from different workers.
- A downstream idempotency key prevents duplicate effects only for the provider's
  actual retention and payload contract. A graph checkpoint or journal lease
  cannot cancel an old executor or create cross-service exactly-once execution.
- The default journal lease is five seconds; the demo and crash tests inject
  logical time with ten-millisecond leases. A `busy` result does not schedule a
  retry. If a node returns `busy`, its graph step has finished; inspecting it
  later requires a new explicit graph invocation with the same logical action.
- The reused [synthetic HTTP adapter](synthetic-http.mjs) binds only `127.0.0.1`
  and has bounded request and response sizes and a finite network deadline.
  SQLite locking is a separate synchronous wait. This example does not offer
  cancellation or a hard end-to-end request latency bound.
- Connections close after graph invocations settle. The CLI preload disables
  inherited LangChain/LangSmith tracing flags for the example process. Normal
  dependency installation still downloads npm packages and native binaries.

For the framework contracts, see LangChain's
[checkpointer documentation](https://docs.langchain.com/oss/javascript/langgraph/persistence),
[fault-tolerance documentation](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance),
and the [official SQLite saver implementation](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite).
