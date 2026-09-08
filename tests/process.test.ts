import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runWorker, resumeWorkerAfter, ledgerCounts, faultPhases, strategies, type FaultPhase, type Strategy } from './fixtures/process.js';
import { SqliteStore } from '../src/index.js';

// Rows describe observable service requests, committed effects, and the caller's
// recovery decision. Downstream deduplication is tested independently of receipt replay.
const expected: Record<Strategy, Record<FaultPhase, [calls: number, effects: number, outcome: string]>> = {
  naive: {
    'before-effect': [1, 1, 'completed'], 'after-effect': [2, 2, 'completed'],
    'after-complete': [2, 2, 'completed'], 'response-loss': [2, 2, 'completed'],
  },
  checkpoint: {
    'before-effect': [1, 1, 'completed'], 'after-effect': [2, 2, 'completed'],
    'after-complete': [1, 1, 'replay'], 'response-loss': [2, 2, 'completed'],
  },
  'downstream-idempotency-only': {
    'before-effect': [1, 1, 'completed'], 'after-effect': [2, 1, 'completed'],
    'after-complete': [2, 1, 'completed'], 'response-loss': [2, 1, 'completed'],
  },
  'journal-idempotent': {
    'before-effect': [1, 1, 'completed'], 'after-effect': [2, 1, 'completed'],
    'after-complete': [1, 1, 'replay'], 'response-loss': [2, 1, 'completed'],
  },
  'journal-manual': {
    'before-effect': [0, 0, 'indeterminate'], 'after-effect': [1, 1, 'indeterminate'],
    'after-complete': [1, 1, 'replay'], 'response-loss': [1, 1, 'indeterminate'],
  },
};

for (const strategy of strategies) for (const phase of faultPhases) {
  test(`${strategy}: restart after ${phase}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-crash-'));
    const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
    try {
      const stopped = await runWorker(journal, ledger, strategy, phase);
      assert.equal(stopped.kind, phase === 'response-loss' ? 'response-lost' : 'paused');
      assert.equal(stopped.result, undefined, 'failure must not provide a receipt to the caller');
      const recovered = await runWorker(journal, ledger, strategy, 'none', 111);
      const [calls, effects, outcome] = expected[strategy][phase];
      assert.equal(recovered.kind, outcome);
      assert.deepEqual(ledgerCounts(ledger), { calls, effects });
      if (strategy.startsWith('journal')) {
        const restarted = await runWorker(journal, ledger, strategy, 'none', 1_000);
        assert.equal(restarted.kind, outcome === 'indeterminate' ? 'indeterminate' : 'replay');
        assert.deepEqual(restarted.result, recovered.result);
        assert.deepEqual(ledgerCounts(ledger), { calls, effects }, 'restart must not invoke the service after a completed or uncertain action');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('both idempotent strategies send the identical stable downstream key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-identity-'));
  try {
    const keys: string[] = [];
    for (const strategy of ['downstream-idempotency-only', 'journal-idempotent'] as const) {
      const journal = join(dir, `${strategy}.sqlite`), ledger = join(dir, `${strategy}-ledger.sqlite`);
      await runWorker(journal, ledger, strategy, 'response-loss');
      await runWorker(journal, ledger, strategy, 'none', 111);
      const db = new DatabaseSync(ledger);
      try {
        const actions = db.prepare('SELECT action FROM calls ORDER BY attempt').all();
        assert.equal(actions.length, 2);
        assert.equal(actions[0]!.action, actions[1]!.action);
        assert.match(String(actions[0]!.action), /^[a-f0-9]{64}$/);
        keys.push(String(actions[0]!.action));
      } finally { db.close(); }
    }
    assert.equal(keys[0], keys[1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repeated lost responses keep one effect and eventually recover its receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-lost-response-'));
  const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
  try {
    for (const now of [100, 111, 122]) {
      assert.equal((await runWorker(journal, ledger, 'journal-idempotent', 'response-loss', now)).kind, 'response-lost');
    }
    const result = await runWorker(journal, ledger, 'journal-idempotent', 'none', 133);
    assert.equal(result.kind, 'completed');
    assert.deepEqual(result.result, { receipt: 1, units: 7 });
    assert.deepEqual(ledgerCounts(ledger), { calls: 4, effects: 1 });
    assert.equal((await runWorker(journal, ledger, 'journal-idempotent', 'none', 200)).kind, 'replay');
    assert.deepEqual(ledgerCounts(ledger), { calls: 4, effects: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const phase of ['before-effect', 'after-effect'] as const) {
  test(`an old executor resumed at ${phase} cannot overwrite a newer receipt`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-old-executor-'));
    const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
    try {
      const old = await resumeWorkerAfter(journal, ledger, 'journal-idempotent', phase, async () => {
        assert.equal((await runWorker(journal, ledger, 'journal-idempotent', 'none', 105)).kind, 'busy');
        assert.equal((await runWorker(journal, ledger, 'journal-idempotent', 'none', 111)).kind, 'completed');
      }, 112);
      assert.equal(old.kind, 'stale');
      const replay = await runWorker(journal, ledger, 'journal-idempotent', 'none', 200);
      assert.equal(replay.kind, 'replay');
      assert.deepEqual(replay.result, { receipt: 1, units: 7 });
      assert.deepEqual(ledgerCounts(ledger), { calls: 2, effects: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('manual uncertainty does not cancel an already running executor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-late-manual-'));
  const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
  try {
    const old = await resumeWorkerAfter(journal, ledger, 'journal-manual', 'before-effect', async () => {
      assert.equal((await runWorker(journal, ledger, 'journal-manual', 'none', 111)).kind, 'indeterminate');
      assert.deepEqual(ledgerCounts(ledger), { calls: 0, effects: 0 });
    }, 112);
    assert.equal(old.kind, 'stale');
    // A journal lease fences the journal, not the service. Quiesce the old
    // executor before externally verifying a receipt and settling uncertainty.
    assert.deepEqual(ledgerCounts(ledger), { calls: 1, effects: 1 });
    assert.equal((await runWorker(journal, ledger, 'journal-manual', 'none', 200)).kind, 'indeterminate');
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

test('competing callers do not contact the downstream during a live journal lease', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-live-lease-'));
  const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
  try {
    const result = await resumeWorkerAfter(journal, ledger, 'journal-idempotent', 'before-effect', async () => {
      const competitors = await Promise.all(Array.from({ length: 8 }, () => runWorker(journal, ledger, 'journal-idempotent', 'none', 105)));
      assert.equal(competitors.filter(r => r.kind === 'busy').length, 8);
      assert.deepEqual(ledgerCounts(ledger), { calls: 0, effects: 0 });
    }, 106);
    assert.equal(result.kind, 'completed');
    assert.deepEqual(ledgerCounts(ledger), { calls: 1, effects: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
