import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, effectCount } from './fixtures/process.js';
import { SqliteStore } from '../src/index.js';

for (const phase of ['before-effect', 'after-effect', 'after-complete']) {
  test(`idempotent downstream survives SIGKILL at ${phase}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-crash-'));
    const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
    try {
      const stopped = await runWorker(journal, ledger, 'journal-idempotent', phase);
      assert.equal(stopped.kind, 'paused');
      const recovered = await runWorker(journal, ledger, 'journal-idempotent', 'none', 111);
      assert.ok(['completed', 'replay'].includes(recovered.kind));
      assert.equal(effectCount(ledger), 1);
      const replay = await runWorker(journal, ledger, 'journal-idempotent', 'none', 1_000);
      assert.equal(replay.kind, 'replay');
      assert.deepEqual(replay.result, recovered.result);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('manual downstream does not repeat an action after an ambiguous crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-manual-'));
  const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
  try {
    await runWorker(journal, ledger, 'journal-manual', 'after-effect');
    const result = await runWorker(journal, ledger, 'journal-manual', 'none', 111);
    assert.equal(result.kind, 'indeterminate');
    assert.equal(effectCount(ledger), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('eight OS processes contend for one slot; exactly one acquires it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-race-'));
  const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
  try {
    new SqliteStore(journal).close();
    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker(journal, ledger, 'claim')));
    assert.equal(results.filter(r => r.kind === 'acquired').length, 1);
    assert.equal(results.filter(r => r.kind === 'busy').length, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
