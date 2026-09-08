import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeChild, RuntimeFixture } from '../benchmarks/runtime-process.js';
import { runBatch, runHeldLock } from '../benchmarks/runtime.js';

test('runtime batch reports measured requests separately from warmup across real workers', async () => {
  const fixture = new RuntimeFixture();
  try {
    const batch = await runBatch(fixture, 'execute', 4, 8, 4);
    assert.equal(batch.latencyMs.n, 8);
    assert.equal(batch.errors, 0);
    assert.equal(batch.workers.length, 4);
    for (const worker of batch.workers) {
      assert.deepEqual(worker.samples.map(sample => sample.sequence), [0, 1]);
      assert.ok(worker.samples.every(sample => sample.outcome === 'completed'));
    }
    const db = new DatabaseSync(join(fixture.directory, 'execute-4-process.sqlite'));
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM tool_journal').get()!.n, 12); }
    finally { db.close(); }
  } finally { await fixture.close(); }
  assert.equal(existsSync(fixture.directory), false);
});

test('held-writer protocol observes both completed reads and new writes without a speed assertion', async () => {
  const fixture = new RuntimeFixture();
  try {
    const replay = await runHeldLock(fixture, 'replay', 50);
    const begin = await runHeldLock(fixture, 'begin', 50);
    assert.equal(replay.outcome, 'replay');
    assert.equal(begin.outcome, 'acquired');
    assert.equal(replay.error, null);
    assert.equal(begin.error, null);
    assert.ok(Number.isFinite(replay.timerDelayMs));
    assert.ok(Number.isFinite(begin.timerDelayMs));
    assert.equal(replay.storageBytes.measuredNetGrowth.wal, 0);
  } finally { await fixture.close(); }
});

test('an early worker exit rejects its pending reply and closes IPC', async () => {
  const worker = new RuntimeChild(['-e', 'process.exit(7)']);
  await assert.rejects(worker.receive('ready'), /exited/);
  await worker.closed;
  await worker.stop();
});

test('malformed worker failures reject through cleanup without an uncaught IPC exception', async () => {
  const fixture = new RuntimeFixture();
  const malformed = [
    { kind: 'failed' },
    { kind: 'failed', error: null },
    { kind: 'failed', error: 'broken' },
    { kind: 'failed', error: {} },
    { kind: 'failed', error: { code: 42, sqliteCode: null } },
    { kind: 'failed', error: { code: 'not-a-public-code', sqliteCode: null } },
    { kind: 'failed', error: { code: 'ERR_SQLITE_ERROR' } },
    { kind: 'failed', error: { code: 'ERR_SQLITE_ERROR', sqliteCode: '5' } },
  ];
  try {
    for (const message of malformed) {
      const worker = fixture.worker(['-e',
        `process.on('message', () => {}); process.send(${JSON.stringify(message)});`]);
      await assert.rejects(worker.receive('ready'), /Unexpected runtime worker failure message/);
      await worker.closed;
    }
    const valid = fixture.worker(['-e',
      `process.on('message', () => {}); process.send({kind:'failed',error:{code:'ERR_SQLITE_ERROR',sqliteCode:5}});`]);
    await assert.rejects(valid.receive('ready'), /Runtime worker reported ERR_SQLITE_ERROR/);
    await valid.closed;
  } finally { await fixture.close(); }
  assert.equal(existsSync(fixture.directory), false);
});

test('a silent worker is killed at its deadline before the waiter rejects', async () => {
  const worker = new RuntimeChild(['-e', 'process.on("message", () => {});'], 200);
  await assert.rejects(worker.receive('ready'), /deadline/);
  await worker.closed;
  await worker.stop();
});

test('fixture cleanup reclaims an active child before removing its own directory', async () => {
  const fixture = new RuntimeFixture();
  const worker = fixture.worker(['-e', 'process.on("message", () => {}); process.send({kind:"ready"});']);
  try { await worker.receive('ready'); }
  finally { await fixture.close(); }
  await worker.closed;
  assert.equal(existsSync(fixture.directory), false);
});
