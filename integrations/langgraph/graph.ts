import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Journal, SqliteStore, type Begin, type Completion, type Intent, type Json } from '@raycarllei/tool-journal';
import { z } from 'zod';
import { requestReceipt } from '#synthetic-http';
import { join } from 'node:path';

const ActionSchema = z.object({
  scope: z.string().min(1).max(512),
  key: z.string().min(1).max(512),
  units: z.number().int().min(1).max(1_000),
  recovery: z.enum(['idempotent', 'manual']),
}).strict();
export type Action = z.infer<typeof ActionSchema>;
export type Outcome = Exclude<Begin, { kind: 'acquired' }> | (Completion & { result: Json });

const State = Annotation.Root({
  action: Annotation<Action>(),
  outcome: Annotation<Outcome | null>({ reducer: (_, next) => next, default: () => null }),
});

export interface RuntimeOptions {
  clock?: () => number;
  leaseMs?: number;
  /** Test injection after journal completion and before the node returns. */
  afterJournalComplete?: () => Promise<void>;
}

export function threadConfig(threadId: string) {
  if (typeof threadId !== 'string' || threadId.length < 1 || threadId.length > 200) throw new TypeError('Invalid graph thread ID');
  return { configurable: { thread_id: threadId }, durability: 'sync' as const, recursionLimit: 8, callbacks: [] };
}

/** Three independent stores: graph checkpoints, tool receipts, and HTTP effects. */
export function openRuntime(directory: string, servicePort: number, options: RuntimeOptions = {}) {
  if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535) throw new TypeError('Expected a loopback port');
  const leaseMs = options.leaseMs ?? 5_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) throw new TypeError('Invalid journal lease duration');
  const store = new SqliteStore(join(directory, 'journal.sqlite'));
  let opened: SqliteSaver | undefined;
  try {
    opened = SqliteSaver.fromConnString(join(directory, 'graph.sqlite'));
    opened.db.pragma('synchronous = FULL');
  } catch (error) {
    try { opened?.db.close(); } finally { store.close(); }
    throw error;
  }
  const checkpointer = opened;
  const journal = new Journal(store, options.clock);

  const graph = new StateGraph(State)
    .addNode('prepare', state => ({ action: ActionSchema.parse(state.action), outcome: null }))
    .addNode('append', async state => {
      const action = ActionSchema.parse(state.action);
      // Logical operation identity comes from the application. LangGraph thread,
      // checkpoint, task, and retry IDs never become a new downstream action key.
      // The synthetic provider retains keys indefinitely. This example still
      // bounds new retry authorization to one minute from the first acquisition.
      const intent: Intent = { scope: action.scope, key: action.key, tool: 'synthetic-http-append', input: { units: action.units },
        ...(action.recovery === 'manual' ? { recovery: action.recovery } : { recovery: action.recovery, retryForMs: 60_000 }) };
      const begun = journal.begin(intent, leaseMs);
      if (begun.kind !== 'acquired') return { outcome: begun };

      // A thrown request error leaves the journal pending and the graph node
      // failed. Resume is an explicit caller decision; this node has one attempt.
      const receipt = await requestReceipt(servicePort, action.recovery, action.units,
        action.recovery === 'idempotent' ? begun.lease.id : undefined);
      const completion = journal.complete(begun.lease, receipt);
      if (completion.kind === 'completed') await options.afterJournalComplete?.();
      return { outcome: { ...completion, result: receipt } };
    }, { retryPolicy: { maxAttempts: 1 } })
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'append')
    .addEdge('append', END)
    .compile({ checkpointer });

  let closed = false;
  return {
    graph,
    checkpointer,
    /** Await invocation/stream completion before closing either connection. */
    close() {
      if (closed) return;
      closed = true;
      try { checkpointer.db.close(); } finally { store.close(); }
    },
  };
}
