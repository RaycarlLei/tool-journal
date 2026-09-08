import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSyntheticService, ReceiptUnavailable } from '#synthetic-http';
import { openRuntime, threadConfig, type Action } from '../graph.js';

function crashWorker(directory: string, port: number, recovery: Action['recovery'], fault: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', new URL('../../scripts/local-only.mjs', import.meta.url).href,
      fileURLToPath(new URL('./worker.js', import.meta.url)), directory, String(port), recovery, fault],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let paused = false;
    let failure: Error | undefined;
    let stderr = '';
    const deadline = setTimeout(() => { failure = new Error('Graph worker timed out'); child.kill('SIGKILL'); }, 15_000);
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8_192); });
    child.once('error', error => { failure = error; });
    child.on('message', message => {
      if ((message as { kind: string }).kind === 'paused') { paused = true; child.kill('SIGKILL'); }
    });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (failure) reject(failure);
      else if (paused && (signal === 'SIGKILL' || code !== 0)) resolve();
      else reject(new Error(`Graph worker exited before the injected crash (${code}, ${signal}): ${stderr}`));
    });
  });
}

test('the graph resolves the packaged public export, not a source directory or symlink', () => {
  const entry = fileURLToPath(import.meta.resolve('@raycarllei/tool-journal'));
  assert.match(entry.replaceAll('\\', '/'), /\/integrations\/langgraph\/node_modules\/@raycarllei\/tool-journal\/dist\/src\/index\.js$/);
  assert.equal(lstatSync(new URL('../../node_modules/@raycarllei/tool-journal', import.meta.url)).isSymbolicLink(), false);
});

for (const recovery of ['idempotent', 'manual'] as const) {
  test(`LangGraph ${recovery}: resume failed node from official SQLite checkpoints after SIGKILL`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'journal-langgraph-failed-'));
    const service = await startSyntheticService(join(directory, 'downstream.sqlite'));
    let runtime: ReturnType<typeof openRuntime> | undefined;
    try {
      service.dropNextReply(recovery);
      await crashWorker(directory, service.port, recovery, 'lost-response');
      const original = service.snapshot();
      assert.equal(original.calls, 1);
      assert.equal(original.effects, 1);
      const config = threadConfig('interrupted-thread');
      runtime = openRuntime(directory, service.port, { clock: () => 111, leaseMs: 10 });
      const checkpoint = await runtime.checkpointer.getTuple(config);
      assert.ok(checkpoint, 'official saver must recover a persisted checkpoint');
      const suspended = await runtime.graph.getState(config);
      assert.deepEqual(suspended.next, ['append']);
      assert.equal(suspended.values.outcome, null);

      const resumed = await runtime.graph.invoke(null, config);
      assert.equal(resumed.outcome?.kind, recovery === 'idempotent' ? 'completed' : 'indeterminate');
      const action: Action = { scope: 'process-test', key: 'append-seven', units: 7, recovery };
      const again = await runtime.graph.invoke({ action }, threadConfig('another-thread'));
      assert.equal(again.outcome?.kind, recovery === 'idempotent' ? 'replay' : 'indeterminate');
      for (const changed of [{ ...action, units: 8 }, { ...action, recovery: recovery === 'manual' ? 'idempotent' as const : 'manual' as const }]) {
        const conflict = await runtime.graph.invoke({ action: changed }, threadConfig('changed-intent'));
        assert.deepEqual(conflict.outcome, { kind: 'conflict' });
      }
      assert.equal(service.snapshot().calls, recovery === 'idempotent' ? 2 : 1);
      assert.deepEqual(service.snapshot().receipts, original.receipts);
    } finally { runtime?.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test(`LangGraph ${recovery}: SIGKILL between journal completion and node checkpoint replays without HTTP`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'journal-langgraph-gap-'));
    const service = await startSyntheticService(join(directory, 'downstream.sqlite'));
    let runtime: ReturnType<typeof openRuntime> | undefined;
    try {
      await crashWorker(directory, service.port, recovery, 'after-journal-complete');
      const original = service.snapshot();
      assert.equal(original.calls, 1);
      const config = threadConfig('interrupted-thread');
      runtime = openRuntime(directory, service.port, { clock: () => 111, leaseMs: 10 });
      const checkpoint = await runtime.graph.getState(config);
      assert.deepEqual(checkpoint.next, ['append']);
      assert.equal(checkpoint.values.outcome, null, 'LangGraph must not already have the completed tool result');
      const resumed = await runtime.graph.invoke(null, config);
      assert.deepEqual(resumed.outcome, { kind: 'replay', result: { receipt: original.receipts[0]!.receipt, units: 7 } });
      assert.deepEqual(service.snapshot(), original);
    } finally { runtime?.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test('separate graph threads coordinate one logical operation through the journal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-langgraph-concurrent-'));
  const service = await startSyntheticService(join(directory, 'downstream.sqlite'));
  const runtime = openRuntime(directory, service.port, { clock: () => 100, leaseMs: 10 });
  try {
    const action: Action = { scope: 'concurrent-test', key: 'append-seven', units: 7, recovery: 'idempotent' };
    const results = await Promise.all(['a', 'b', 'c'].map(thread => runtime.graph.invoke({ action }, threadConfig(thread))));
    assert.equal(results.filter(result => result.outcome?.kind === 'completed').length, 1);
    assert.ok(results.every(result => ['completed', 'busy', 'replay'].includes(result.outcome!.kind)));
    assert.equal(service.snapshot().calls, 1);
    assert.equal(service.snapshot().effects, 1);
  } finally { runtime.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('manual failure has no graph retry and resumes to uncertainty after its lease expires', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-langgraph-manual-'));
  const service = await startSyntheticService(join(directory, 'downstream.sqlite'));
  let now = 100;
  const runtime = openRuntime(directory, service.port, { clock: () => now, leaseMs: 10 });
  try {
    const action: Action = { scope: 'manual-test', key: 'append-seven', units: 7, recovery: 'manual' };
    const config = threadConfig('manual-thread');
    service.dropNextReply('manual');
    await assert.rejects(runtime.graph.invoke({ action }, config), ReceiptUnavailable);
    assert.equal(service.snapshot().calls, 1);
    assert.deepEqual((await runtime.graph.invoke(null, config)).outcome, { kind: 'busy', leaseUntil: 110 });
    now = 111;
    // The busy result completed that node; a new graph turn explicitly asks to
    // inspect the same operation again. It cannot authorize another side effect.
    assert.deepEqual((await runtime.graph.invoke({ action }, config)).outcome, { kind: 'indeterminate' });
    assert.equal(service.snapshot().calls, 1);
  } finally { runtime.close(); await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
