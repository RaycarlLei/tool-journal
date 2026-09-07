import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, MemoryStore, SqliteStore, type Intent, type Lease } from '../src/index.js';
import { canonical } from '../src/json.js';

const intent: Intent = { scope: 'synthetic', key: 'action-1', tool: 'append', input: { units: 7 }, recovery: 'idempotent' };
function acquire(journal: Journal, value = intent): Lease {
  const result = journal.begin(value, 10);
  assert.equal(result.kind, 'acquired');
  if (result.kind !== 'acquired') throw new Error('Expected acquired');
  return result.lease;
}

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: lease lifecycle, fencing and result replay`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-test-'));
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(join(dir, 'state.sqlite'));
    let now = 100;
    const journal = new Journal(store, () => now);
    try {
      const first = acquire(journal);
      assert.equal(journal.begin(intent).kind, 'busy');
      assert.equal(journal.begin({ ...intent, input: { units: 8 } }).kind, 'conflict');
      assert.equal(journal.begin({ ...intent, tool: 'delete' }).kind, 'conflict');
      assert.equal(journal.begin({ ...intent, recovery: 'manual' }).kind, 'conflict');
      now = 110;
      assert.equal(journal.complete(first, null).kind, 'stale');
      assert.equal(journal.renew(first), false);
      const second = acquire(journal);
      assert.equal(second.epoch, 2);
      assert.equal(journal.complete(first, null).kind, 'stale');
      assert.equal(journal.renew(first), false);
      assert.equal(journal.complete({ ...second, executor: 'someone-else' }, null).kind, 'stale');
      assert.equal(journal.complete(second, { receipt: [null, false, 0] }).kind, 'completed');
      now = 10_000;
      assert.equal(journal.complete(second, { receipt: [null, false, 0] }).kind, 'replayed');
      assert.equal(journal.complete(second, {}).kind, 'conflict');
      assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: [null, false, 0] } });
      assert.equal(journal.begin({ ...intent, scope: 'another-owner' }).kind, 'acquired');
      assert.equal(journal.renew(second), false);
    } finally {
      if (store instanceof SqliteStore) store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('manual recovery blocks retries until an independently verified settlement', () => {
  let now = 0;
  const j = new Journal(new MemoryStore(), () => now);
  const value: Intent = { ...intent, recovery: 'manual' };
  const lease = acquire(j, value);
  assert.equal(j.settle(value, { receipt: 1 }), 'not_indeterminate');
  now = 10;
  assert.equal(j.begin(value).kind, 'indeterminate');
  now = 100_000;
  assert.equal(j.begin(value).kind, 'indeterminate');
  assert.equal(j.complete(lease, {}).kind, 'stale');
  assert.equal(j.settle({ ...value, input: null }, {}), 'conflict');
  assert.equal(j.settle(value, { receipt: 1 }), 'settled');
  assert.equal(j.settle(value, { receipt: 1 }), 'replayed');
  assert.equal(j.settle(value, { receipt: 2 }), 'conflict');
  assert.deepEqual(j.begin(value), { kind: 'replay', result: { receipt: 1 } });
});

test('renewal never shortens a lease and never resurrects an expired lease', () => {
  let now = 100;
  const j = new Journal(new MemoryStore(), () => now);
  const lease = acquire(j);
  now = 105;
  assert.equal(j.renew(lease, 1), true);
  assert.deepEqual(j.begin(intent), { kind: 'busy', leaseUntil: 110 });
  assert.equal(j.renew(lease, 50), true);
  now = 155;
  assert.equal(j.renew(lease, 10), false);
});

test('storage errors escape without authorizing a tool invocation', () => {
  const j = new Journal({ transact() { throw new Error('disk unavailable'); } });
  assert.throws(() => j.begin(intent), /disk unavailable/);
});

test('time is sampled inside the transaction and bad clocks are rejected', () => {
  let now = 0;
  const memory = new MemoryStore();
  const j = new Journal({ transact(id, f) { now += 100; return memory.transact(id, f); } }, () => now);
  const lease = acquire(j);
  assert.equal(j.complete(lease, null).kind, 'stale');
  assert.throws(() => new Journal(memory, () => NaN).begin(intent), /Clock/);
  assert.throws(() => new Journal(memory).begin(intent, 0), /Lease/);
});

test('canonical input preserves JSON meaning without silently coercing values', () => {
  assert.equal(canonical({ b: 2, a: [true, null] }), canonical({ a: [true, null], b: 2 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical(JSON.parse('{"__proto__":1}')), '{"__proto__":1}');
  for (const bad of [undefined, NaN, Infinity, 1n, new Date(), new Map(), [, 1], { x: undefined }]) {
    assert.throws(() => canonical(bad), TypeError);
  }
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => canonical(cycle), /Cyclic/);
  assert.throws(() => canonical({ get value() { throw new Error('must not run'); } }), /accessor/);
  assert.throws(() => canonical('a'.repeat(1_048_577)), /MiB/);
});

test('SQLite rollback, reopen, and corruption fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-corruption-'));
  const path = join(dir, 'state.sqlite');
  let store = new SqliteStore(path);
  try {
    const j = new Journal(store, () => 0);
    const lease = acquire(j);
    assert.throws(() => store.transact(lease.id, () => { throw new Error('abort'); }), /abort/);
    assert.equal(j.complete(lease, { receipt: 1 }).kind, 'completed');
    store.close(); store = new SqliteStore(path);
    assert.equal(new Journal(store).begin(intent).kind, 'replay');
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE tool_journal SET entry = ?').run('{"version":9}');
    raw.close();
    assert.throws(() => new Journal(store).begin(intent), /Corrupt/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
