import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSyntheticService, ReceiptUnavailable } from '#synthetic-http';
import { openRuntime, threadConfig, type Action } from './graph.js';

const directory = mkdtempSync(join(tmpdir(), 'journal-langgraph-demo-'));
try {
  for (const recovery of ['idempotent', 'manual'] as const) {
    const service = await startSyntheticService(join(directory, `${recovery}-downstream.sqlite`));
    let runtime: ReturnType<typeof openRuntime> | undefined;
    try {
      let now = 100;
      runtime = openRuntime(directory, service.port, { clock: () => now, leaseMs: 10 });
      const config = threadConfig(`${recovery}-thread`);
      const action: Action = { scope: `synthetic-${recovery}`, key: 'append-seven', units: 7, recovery };
      service.dropNextReply(recovery);
      await assert.rejects(runtime.graph.invoke({ action }, config), ReceiptUnavailable);
      assert.equal(service.snapshot().effects, 1);
      runtime.close();
      runtime = openRuntime(directory, service.port, { clock: () => now, leaseMs: 10 });
      now = 111;
      const recovered = await runtime.graph.invoke(null, config);
      assert.equal(recovered.outcome?.kind, recovery === 'idempotent' ? 'completed' : 'indeterminate');
      // A separate graph invocation must execute its node again. This tests the
      // journal's replay, rather than LangGraph simply returning a saved result.
      const repeated = await runtime.graph.invoke({ action }, threadConfig(`${recovery}-another-thread`));
      assert.equal(repeated.outcome?.kind, recovery === 'idempotent' ? 'replay' : 'indeterminate');
      const ledger = service.snapshot();
      assert.equal(ledger.calls, recovery === 'idempotent' ? 2 : 1);
      assert.equal(ledger.effects, 1);
      console.log(JSON.stringify({ recovery, resumedNode: recovered.outcome?.kind, newThread: repeated.outcome?.kind, calls: ledger.calls, effects: ledger.effects }));
    } finally {
      runtime?.close();
      await service.close();
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
