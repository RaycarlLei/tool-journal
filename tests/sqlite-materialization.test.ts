import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Journal, SqliteStore, type Intent } from '../src/index.js';

// Wire-format limits, deliberately independent of the implementation's SQL.
const recordBytes = 2 * 1_048_576 + 4_096;
const storageBytes = 2 * recordBytes;
const id = 'a'.repeat(64);

function withFile(run: (path: string, raw: DatabaseSync) => void): void {
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'journal-materialization-')));
  assert.equal(dirname(directory), root);
  const path = join(directory, 'journal.sqlite');
  const raw = new DatabaseSync(path);
  try { run(path, raw); }
  finally {
    try { raw.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function createSchema(raw: DatabaseSync, version: 1 | 2, encoding?: string): void {
  if (encoding) raw.exec(`PRAGMA encoding = '${encoding}'`);
  raw.exec(`CREATE TABLE journal_meta (version INTEGER NOT NULL) STRICT;
    INSERT INTO journal_meta VALUES (${version});
    CREATE TABLE tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT;`);
}

function entry(version: 1 | 2, result: string | null = null, identity = id): string {
  return JSON.stringify({
    version, id: identity, fingerprint: 'b'.repeat(64), recovery: 'manual',
    state: result === null ? 'pending' : 'completed', epoch: 1,
    executor: 'materialization-test', leaseUntil: 10, result,
    ...(version === 2 ? { firstAcquiredAt: 0, retryForMs: null, retryStartBefore: null } : {}),
  });
}

interface ObservedRead { field: string; bytes: number }

/** Observe values the native wrapper actually hands to JS, not just SQL text. */
function observeReads(t: TestContext, action: () => void): ObservedRead[] {
  const observed: ObservedRead[] = [];
  const inspect = (row: Record<string, unknown> | undefined) => {
    if (!row) return;
    for (const [field, value] of Object.entries(row)) {
      if (typeof value === 'string') observed.push({ field, bytes: Buffer.byteLength(value) });
      else if (ArrayBuffer.isView(value)) observed.push({ field, bytes: value.byteLength });
    }
  };
  const originalGet = StatementSync.prototype.get;
  const originalAll = StatementSync.prototype.all;
  const get = t.mock.method(StatementSync.prototype, 'get', function (this: StatementSync, ...parameters: unknown[]) {
    const row = Reflect.apply(originalGet, this, parameters) as ReturnType<StatementSync['get']>;
    inspect(row);
    return row;
  });
  const all = t.mock.method(StatementSync.prototype, 'all', function (this: StatementSync, ...parameters: unknown[]) {
    const rows = Reflect.apply(originalAll, this, parameters) as ReturnType<StatementSync['all']>;
    for (const row of rows) inspect(row);
    return rows;
  });
  try { action(); }
  finally { get.mock.restore(); all.mock.restore(); }
  return observed;
}

function assertBounded(reads: ObservedRead[], limit = storageBytes): void {
  assert.ok(reads.every(read => read.bytes <= limit),
    `SQLite returned an oversized value before validation: ${JSON.stringify(reads.filter(read => read.bytes > limit))}`);
}

test('an oversized current record never reaches JS or its transaction callback', t => {
  withFile((path, raw) => {
    const store = new SqliteStore(path);
    try {
      const intent: Intent = { scope: 'bounded-read', key: 'one', tool: 'append', input: {}, recovery: 'manual' };
      const journal = new Journal(store, () => 0);
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected a lease');
      const original = raw.prepare('SELECT entry FROM tool_journal WHERE id=?').get(begun.lease.id)!.entry as string;
      const oversized = JSON.stringify({ ...JSON.parse(original), state: 'completed', result: JSON.stringify('x'.repeat(storageBytes)) });
      raw.prepare('UPDATE tool_journal SET entry=? WHERE id=?').run(oversized, begun.lease.id);
      let entered = false;
      const reads = observeReads(t, () => {
        assert.throws(() => store.transact(begun.lease.id, () => {
          entered = true;
          return { value: 'must not run' };
        }), /Corrupt journal entry/);
      });
      assert.equal(entered, false);
      assertBounded(reads);
      assert.equal(raw.prepare('SELECT entry=? AS unchanged FROM tool_journal WHERE id=?').get(oversized, begun.lease.id)!.unchanged, 1);
      // The failed read releases its writer lock and preserves the old lease.
      raw.prepare('UPDATE tool_journal SET entry=? WHERE id=?').run(original, begun.lease.id);
      assert.deepEqual(journal.begin(intent, 10), { kind: 'busy', leaseUntil: 10 });
    } finally { store.close(); }
  });
});

test('an oversized autocommit snapshot never returns its payload to JS', t => {
  withFile((path, raw) => {
    const store = new SqliteStore(path);
    try {
      const original = entry(2);
      const oversized = entry(2, JSON.stringify('x'.repeat(storageBytes)));
      raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(id, oversized);
      const reads = observeReads(t, () => {
        assert.throws(() => store.read(id), /Corrupt journal entry/);
      });
      assertBounded(reads);
      assert.equal(raw.prepare('SELECT entry=? AS unchanged FROM tool_journal WHERE id=?').get(oversized, id)!.unchanged, 1);
      raw.prepare('UPDATE tool_journal SET entry=? WHERE id=?').run(original, id);
      assert.equal(store.read(id)!.state, 'pending');
    } finally { store.close(); }
  });
});

test('migration rejects oversized TEXT before materialization and retains the original rows', t => {
  withFile((path, raw) => {
    createSchema(raw, 1);
    const good = entry(1);
    const badId = 'c'.repeat(64);
    const oversized = entry(1, JSON.stringify('x'.repeat(storageBytes)), badId);
    raw.prepare('INSERT INTO tool_journal VALUES (?, ?), (?, ?)').run(id, good, badId, oversized);
    let opened: SqliteStore | undefined;
    const reads = observeReads(t, () => {
      try { assert.throws(() => { opened = new SqliteStore(path); }, /Corrupt journal entry/); }
      finally { opened?.close(); }
    });
    assertBounded(reads);
    assert.equal(raw.prepare('SELECT version FROM journal_meta').get()!.version, 1);
    assert.equal(raw.prepare('SELECT entry=? AS unchanged FROM tool_journal WHERE id=?').get(good, id)!.unchanged, 1);
    assert.equal(raw.prepare('SELECT entry=? AS unchanged FROM tool_journal WHERE id=?').get(oversized, badId)!.unchanged, 1);
    raw.exec('BEGIN IMMEDIATE; ROLLBACK;');
    raw.prepare('UPDATE tool_journal SET entry=? WHERE id=?').run(entry(1, null, badId), badId);
    const repaired = new SqliteStore(path);
    try { assert.equal(repaired.transact(id, current => ({ value: current!.version })), 2); }
    finally { repaired.close(); }
  });
});

test('migration refuses an oversized identity without returning that identity to JS', t => {
  withFile((path, raw) => {
    createSchema(raw, 1);
    const largeId = 'f'.repeat(256 * 1024);
    const encoded = entry(1, null, largeId);
    raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(largeId, encoded);
    let opened: SqliteStore | undefined;
    const reads = observeReads(t, () => {
      try { assert.throws(() => { opened = new SqliteStore(path); }, /Corrupt journal entry/); }
      finally { opened?.close(); }
    });
    assertBounded(reads.filter(read => read.field === 'id'), 128);
    assert.equal(raw.prepare('SELECT version FROM journal_meta').get()!.version, 1);
    assert.equal(raw.prepare('SELECT id=? AND entry=? AS unchanged FROM tool_journal').get(largeId, encoded)!.unchanged, 1);
    raw.exec('BEGIN IMMEDIATE; ROLLBACK;');
  });
});

for (const [name, expression] of [
  ['text version', "'2'"],
  ['real version', '2.0'],
  ['blob version', "x'02'"],
  ['oversized version', `printf('%.*c', ${storageBytes + 1}, '2')`],
] as const) {
  test(`opening a journal rejects ${name} without returning an oversized metadata value`, t => {
    withFile((path, raw) => {
      // ANY preserves the wrong storage type instead of INTEGER affinity fixing it.
      raw.exec(`CREATE TABLE journal_meta (version ANY NOT NULL) STRICT;
        INSERT INTO journal_meta VALUES (${expression});
        CREATE TABLE tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT;`);
      raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(id, entry(2));
      const before = raw.prepare('SELECT typeof(version) AS type, octet_length(version) AS bytes FROM journal_meta').get();
      let opened: SqliteStore | undefined;
      const reads = observeReads(t, () => {
        try { assert.throws(() => { opened = new SqliteStore(path); }, /Unsupported journal schema/); }
        finally { opened?.close(); }
      });
      assertBounded(reads);
      assert.deepEqual(raw.prepare('SELECT typeof(version) AS type, octet_length(version) AS bytes FROM journal_meta').get(), before);
      assert.equal(raw.prepare('SELECT count(*) AS count FROM tool_journal').get()!.count, 1);
      assert.equal(raw.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'").get()!.count, 0);
      raw.exec('BEGIN IMMEDIATE; ROLLBACK;');
    });
  });
}

for (const version of [1, 2] as const) {
  for (const encoding of ['UTF-16le', 'UTF-16be']) {
    test(`version ${version} accepts a valid large ${encoding} receipt containing non-ASCII text`, t => {
      withFile((path, raw) => {
        createSchema(raw, version, encoding);
        // Escaped quotes make the outer record larger than the canonical result.
        // UTF-16 storage exceeds the UTF-8 limit without violating that limit.
        const result = '\u0080"'.repeat(240_000) + '汉';
        const encoded = entry(version, JSON.stringify(result));
        assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_048_576);
        assert.ok(Buffer.byteLength(encoded) < recordBytes);
        raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(id, encoded);
        const stored = raw.prepare('SELECT octet_length(entry) AS bytes FROM tool_journal').get()!.bytes as number;
        assert.ok(stored > recordBytes && stored <= storageBytes);
        let store: SqliteStore | undefined;
        try {
          const reads = observeReads(t, () => {
            store = new SqliteStore(path);
            const replay = store.transact(id, current => ({ value: current!.result }));
            assert.equal(JSON.parse(replay!), result);
          });
          assertBounded(reads);
          assert.equal(raw.prepare('SELECT version FROM journal_meta').get()!.version, 2);
        } finally { store?.close(); }
      });
    });
  }
}
