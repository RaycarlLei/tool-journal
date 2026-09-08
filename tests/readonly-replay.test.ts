import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Journal, MemoryStore, SqliteStore, type Intent, type Store } from '../src/index.js';

const intent: Intent = { scope: 'read-replay', key: 'one', tool: 'append', input: { units: 7 }, recovery: 'idempotent', retryForMs: 100 };

function completed(store: Store) {
  const journal = new Journal(store, () => 0);
  const begun = journal.begin(intent, 10);
  assert.equal(begun.kind, 'acquired');
  if (begun.kind !== 'acquired') throw new Error('Expected a lease');
  assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
  return { journal, id: begun.lease.id };
}

test('SQLite replays the committed receipt while another connection holds an uncommitted write', () => {
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'journal-read-replay-')));
  assert.equal(dirname(directory), root);
  const path = join(directory, 'journal.sqlite');
  const store = new SqliteStore(path);
  const writer = new DatabaseSync(path);
  try {
    const { journal, id } = completed(store);
    writer.exec('BEGIN IMMEDIATE');
    const row = JSON.parse(String(writer.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(id)!.entry));
    writer.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?')
      .run(JSON.stringify({ ...row, result: '{"receipt":2}' }), id);

    // The writer stays locked until these assertions return. This proves the
    // path needs no writer lock without imposing a machine-speed threshold.
    assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
    assert.deepEqual(journal.begin({ ...intent, input: { units: 8 } }), { kind: 'conflict' });
    assert.deepEqual(journal.begin({ ...intent, retryForMs: 101 }), { kind: 'conflict' });
    assert.equal(writer.isTransaction, true);
    writer.exec('ROLLBACK');
    assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
  } finally {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    writer.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: completed snapshots preserve validation, isolation and nested-access checks`, () => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    try {
      const { journal, id } = completed(store);
      for (const duration of [0, -1, 1.5, NaN, Infinity, 86_400_001]) {
        assert.throws(() => journal.begin(intent, duration), /Lease/);
      }
      for (const now of [-1, NaN, Infinity, 0.5]) {
        assert.throws(() => new Journal(store, () => now).begin(intent), /Clock/);
      }
      assert.throws(() => new Journal(store, () => Number.MAX_SAFE_INTEGER).begin(intent, 1), /Lease/);
      store.transact(id, () => {
        assert.throws(() => store.read(id), /Nested journal transaction/);
        assert.throws(() => journal.begin(intent), /Nested journal transaction/);
        return { value: undefined };
      });
      const snapshot = store.read(id)!;
      snapshot.result = '{"receipt":99}';
      assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
    } finally { if (store instanceof SqliteStore) store.close(); }
  });
}

for (const state of ['absent', 'pending'] as const) {
  test(`${state} snapshots cannot authorize execution after committed state changes`, () => {
    const memory = new MemoryStore();
    const concurrent = new Journal(memory, () => 0);
    const first = state === 'pending' ? concurrent.begin(intent, 10) : undefined;
    const wrapper: Store = {
      read(id) {
        const snapshot = memory.read(id);
        if (first?.kind === 'acquired') concurrent.complete(first.lease, { receipt: 1 });
        else assert.equal(concurrent.begin(intent, 10).kind, 'acquired');
        return snapshot;
      },
      transact: (id, change) => memory.transact(id, change),
    };
    assert.deepEqual(new Journal(wrapper, () => 0).begin(intent),
      state === 'pending' ? { kind: 'replay', result: { receipt: 1 } } : { kind: 'busy', leaseUntil: 10 });
  });
}

test('snapshot errors escape without falling back to execution', () => {
  let transactions = 0;
  const store: Store = {
    read() { throw new Error('read unavailable'); },
    transact() { transactions++; throw new Error('must not transact'); },
  };
  assert.throws(() => new Journal(store).begin(intent), /read unavailable/);
  assert.equal(transactions, 0);
});

test('an adapter without read retains the transactional replay path', () => {
  const memory = new MemoryStore();
  let transactions = 0;
  const legacy: Store = { transact(id, change) { transactions++; return memory.transact(id, change); } };
  const { journal } = completed(legacy);
  assert.equal(transactions, 2);
  assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
  assert.equal(transactions, 3);
});
