import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Journal, SqliteStore, type Intent } from '../src/index.js';

const intent: Intent = { scope: 'schema-initialization', key: 'one-effect', tool: 'append', input: { units: 1 }, recovery: 'manual' };

function withFile(run: (path: string) => void): void {
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'journal-schema-initialization-')));
  try { run(join(directory, 'journal.sqlite')); }
  finally {
    const resolved = realpathSync(directory);
    assert.equal(resolved, directory);
    assert.equal(dirname(resolved), root);
    assert.ok(basename(resolved).startsWith('journal-schema-initialization-'));
    rmSync(resolved, { recursive: true, force: true });
  }
}

function schema(db: DatabaseSync) {
  return db.prepare('SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name').all();
}

function rejectedOpen(path: string): void {
  let opened: SqliteStore | undefined;
  try {
    assert.throws(() => { opened = new SqliteStore(path); }, /Unsupported journal schema/);
  } finally { opened?.close(); }
}

test('losing both journal tables cannot turn a completed manual action into a fresh grant', () => {
  withFile(path => {
    const store = new SqliteStore(path);
    try {
      const journal = new Journal(store, () => 100);
      const begun = journal.begin(intent);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected a lease');
      assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
    } finally { store.close(); }
    const raw = new DatabaseSync(path);
    try {
      raw.exec('DROP TABLE tool_journal; DROP TABLE journal_meta');
      const version = raw.prepare('PRAGMA schema_version').get()!.schema_version;
      assert.ok(Number(version) > 0);
      assert.deepEqual(schema(raw), []);
      rejectedOpen(path);
      assert.deepEqual(schema(raw), []);
      assert.equal(raw.prepare('PRAGMA schema_version').get()!.schema_version, version);
      // A rejected constructor releases its transaction and connection.
      raw.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally { raw.close(); }
  });
});

test('an unrelated schema is rejected without adding journal tables or changing user rows', () => {
  withFile(path => {
    const raw = new DatabaseSync(path);
    try {
      raw.exec("CREATE TABLE app_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO app_data VALUES (1, 'keep'); CREATE VIEW app_view AS SELECT value FROM app_data;");
      const before = schema(raw);
      const version = raw.prepare('PRAGMA schema_version').get()!.schema_version;
      rejectedOpen(path);
      assert.deepEqual(schema(raw), before);
      assert.equal(raw.prepare('SELECT value FROM app_data WHERE id=1').get()!.value, 'keep');
      assert.equal(raw.prepare('PRAGMA schema_version').get()!.schema_version, version);
      // Even a reset counter cannot make existing schema objects an empty DB.
      // This raw fixture simulates an external editor; the adapter stays defensive.
      raw.enableDefensive(false);
      raw.exec('PRAGMA schema_version=0');
      raw.enableDefensive(true);
      assert.equal(raw.prepare('PRAGMA schema_version').get()!.schema_version, 0);
      rejectedOpen(path);
      assert.deepEqual(schema(raw), before);
      assert.equal(raw.prepare('SELECT value FROM app_data WHERE id=1').get()!.value, 'keep');
      assert.equal(raw.prepare('PRAGMA schema_version').get()!.schema_version, 0);
      raw.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally { raw.close(); }
  });
});

for (const kind of ['new path', 'empty file'] as const) {
  test(`${kind} can initialize and retain a completed receipt on reopen`, () => {
    withFile(path => {
      if (kind === 'empty file') writeFileSync(path, '', { flag: 'wx' });
      let store = new SqliteStore(path);
      try {
        const journal = new Journal(store, () => 100);
        const begun = journal.begin(intent);
        assert.equal(begun.kind, 'acquired');
        if (begun.kind !== 'acquired') throw new Error('Expected a lease');
        assert.equal(begun.retry, false);
        assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
        store.close();
        store = new SqliteStore(path);
        assert.deepEqual(new Journal(store).begin(intent), { kind: 'replay', result: { receipt: 1 } });
      } finally { store.close(); }
    });
  });
}

for (const version of [1, 2] as const) {
  test(`existing schema v${version} keeps its receipt and identity instead of reinitializing`, () => {
    withFile(path => {
      const raw = new DatabaseSync(path);
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      // Frozen valid wire data: this compatibility check does not use today's encoder.
      const entry = {
        version, id: digest([intent.scope, intent.key]), fingerprint: digest([intent.tool, intent.input, intent.recovery]),
        recovery: 'manual', state: 'completed', epoch: 4, executor: 'existing-owner', leaseUntil: 110,
        result: '{"receipt":1}',
        ...(version === 2 ? { firstAcquiredAt: 100, retryForMs: null, retryStartBefore: null } : {}),
      };
      try {
        raw.exec(`CREATE TABLE journal_meta (version INTEGER NOT NULL) STRICT; INSERT INTO journal_meta VALUES (${version}); CREATE TABLE tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT;`);
        raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(entry.id, JSON.stringify(entry));
        const store = new SqliteStore(path);
        try {
          assert.deepEqual(new Journal(store, () => 1_000).begin(intent), { kind: 'replay', result: { receipt: 1 } });
          assert.equal(raw.prepare('SELECT version FROM journal_meta').get()!.version, 2);
          assert.equal(raw.prepare('SELECT count(*) AS n FROM tool_journal').get()!.n, 1);
          const persisted = JSON.parse(String(raw.prepare('SELECT entry FROM tool_journal WHERE id=?').get(entry.id)!.entry));
          assert.deepEqual(persisted, {
            ...entry, version: 2, firstAcquiredAt: version === 1 ? null : 100, retryForMs: null, retryStartBefore: null,
          });
        } finally { store.close(); }
      } finally { raw.close(); }
    });
  });
}
