import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, MemoryStore, SqliteStore, type Intent, type Lease } from '../src/index.js';

const intent: Intent = { scope: 'retry-window', key: 'one-action', tool: 'append', input: { units: 7 }, recovery: 'idempotent', retryForMs: 20 };

function temporaryDirectory(): string {
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'journal-retry-window-')));
  assert.equal(dirname(directory), root);
  return directory;
}

interface Runtime {
  now: number;
  journal: Journal;
  reopen(): void;
}

function withRuntime(adapter: 'memory' | 'sqlite', run: (runtime: Runtime) => void): void {
  const directory = adapter === 'sqlite' ? temporaryDirectory() : undefined;
  const memory = new MemoryStore();
  let store = directory ? new SqliteStore(join(directory, 'journal.sqlite')) : memory;
  const runtime: Runtime = {
    now: 100,
    journal: new Journal(store, () => runtime.now),
    reopen() {
      if (store instanceof SqliteStore) store.close();
      store = directory ? new SqliteStore(join(directory, 'journal.sqlite')) : memory;
      runtime.journal = new Journal(store, () => runtime.now);
    },
  };
  try { run(runtime); }
  finally {
    if (store instanceof SqliteStore) store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function acquire(journal: Journal, value = intent, leaseMs = 5) {
  const begun = journal.begin(value, leaseMs);
  assert.equal(begun.kind, 'acquired');
  if (begun.kind !== 'acquired') throw new Error('Expected a grant');
  return begun;
}

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: only admissions strictly before the fixed cutoff can retry`, () => {
    withRuntime(adapter, runtime => {
      const first = acquire(runtime.journal);
      assert.equal(first.retryStartBefore, 120);
      assert.equal(first.retry, false);
      runtime.now = 105;
      const second = acquire(runtime.journal);
      assert.equal(second.retryStartBefore, 120);
      assert.equal(second.retry, true);
      runtime.reopen();
      runtime.now = 119;
      const last = acquire(runtime.journal, intent, 1);
      assert.equal(last.retryStartBefore, 120);
      runtime.now = 120;
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'indeterminate' });
      assert.equal(runtime.journal.complete(last.lease, { receipt: 1 }).kind, 'stale');
      runtime.now = 121;
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'indeterminate' });
      runtime.reopen();
      runtime.now = 101; // A backward clock cannot undo a persisted decision.
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'indeterminate' });
    });
  });

  test(`${adapter}: a live owner can renew and complete after admission closes`, () => {
    withRuntime(adapter, runtime => {
      const first = acquire(runtime.journal, intent, 30);
      runtime.now = 120;
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'busy', leaseUntil: 130 });
      assert.equal(runtime.journal.renew(first.lease, 50), true);
      runtime.reopen();
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'busy', leaseUntil: 170 });
      runtime.now = 169;
      assert.equal(runtime.journal.complete(first.lease, { receipt: 1 }).kind, 'completed');
      runtime.now = 1_000;
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
      assert.deepEqual(runtime.journal.begin({ ...intent, retryForMs: 21 }), { kind: 'conflict' });
    });
  });

  test(`${adapter}: changed retry policy conflicts before and after uncertainty`, () => {
    withRuntime(adapter, runtime => {
      acquire(runtime.journal);
      const changed: Intent = { ...intent, retryForMs: 21 };
      assert.deepEqual(runtime.journal.begin(changed), { kind: 'conflict' });
      runtime.now = 120;
      assert.deepEqual(runtime.journal.begin(changed), { kind: 'conflict' });
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'indeterminate' });
      assert.equal(runtime.journal.settle(changed, { receipt: 1 }), 'conflict');
      assert.equal(runtime.journal.settle(intent, { receipt: 1 }), 'settled');
      assert.deepEqual(runtime.journal.begin(changed), { kind: 'conflict' });
      assert.deepEqual(runtime.journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
    });
  });

  test(`${adapter}: manual grants have no automatic recovery window`, () => {
    withRuntime(adapter, runtime => {
      const manual: Intent = { scope: intent.scope, key: intent.key, tool: intent.tool, input: intent.input, recovery: 'manual' };
      const first = acquire(runtime.journal, manual);
      assert.equal(first.retryStartBefore, null);
      runtime.now = 105;
      assert.deepEqual(runtime.journal.begin(manual), { kind: 'indeterminate' });
    });
  });
}

test('the initial retry window is anchored after storage lock acquisition', () => {
  let now = 100;
  const memory = new MemoryStore();
  const journal = new Journal({ transact(id, change) { now = 150; return memory.transact(id, change); } }, () => now);
  assert.equal(acquire(journal).retryStartBefore, 170);
});

test('invalid windows and arithmetic overflow cannot leave a partial first grant', () => {
  const memory = new MemoryStore();
  let now = 100;
  const journal = new Journal(memory, () => now);
  for (const invalid of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => journal.begin({ ...intent, retryForMs: invalid } as unknown as Intent), TypeError);
  }
  assert.throws(() => journal.begin({ ...intent, recovery: 'manual' } as unknown as Intent), TypeError);
  now = Number.MAX_SAFE_INTEGER - 2;
  assert.throws(() => journal.begin({ ...intent, retryForMs: 3 }, 1), TypeError);
  now = 0;
  const valid = acquire(journal, { ...intent, retryForMs: Number.MAX_SAFE_INTEGER }, 1);
  assert.equal(valid.retry, false);
  assert.equal(valid.retryStartBefore, Number.MAX_SAFE_INTEGER);
});

test('corrupt v2 retry metadata stops reads before authorization and leaves the connection usable', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'journal.sqlite');
  const store = new SqliteStore(path);
  const raw = new DatabaseSync(path);
  let now = 100;
  const journal = new Journal(store, () => now);
  try {
    const first = acquire(journal);
    const select = raw.prepare('SELECT entry FROM tool_journal WHERE id = ?');
    const replace = raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?');
    const original = String(select.get(first.lease.id)!.entry);
    const cases: Array<[string, (entry: Record<string, unknown>) => void]> = [
      ...['firstAcquiredAt', 'retryForMs', 'retryStartBefore'].map(field =>
        [`missing ${field}`, (entry: Record<string, unknown>) => { delete entry[field]; }] as [string, (entry: Record<string, unknown>) => void]),
      ...['firstAcquiredAt', 'retryForMs', 'retryStartBefore'].flatMap(field =>
        [-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1].map(value =>
          [`${field}=${value}`, (entry: Record<string, unknown>) => { entry[field] = value; }] as [string, (entry: Record<string, unknown>) => void])),
      ['zero window', entry => { entry.retryForMs = 0; entry.retryStartBefore = 100; }],
      ['inconsistent cutoff', entry => { entry.retryStartBefore = 121; }],
      ['lease before first acquisition', entry => { entry.leaseUntil = 99; }],
      ['lease equal to first acquisition', entry => { entry.leaseUntil = 100; }],
      ['overflowing sum', entry => {
        entry.firstAcquiredAt = Number.MAX_SAFE_INTEGER - 5;
        entry.retryStartBefore = Number.MAX_SAFE_INTEGER - 5 + 20;
      }],
      ['manual with bounded window', entry => { entry.recovery = 'manual'; }],
      ['manual with unknown first and known window', entry => { entry.recovery = 'manual'; entry.firstAcquiredAt = null; }],
      ['known first with unknown window', entry => { entry.retryForMs = null; entry.retryStartBefore = null; }],
      ['unknown first with known window', entry => { entry.firstAcquiredAt = null; }],
      ['missing cutoff with known first and duration', entry => { entry.retryStartBefore = null; }],
      ['unknown first and duration with known cutoff', entry => { entry.firstAcquiredAt = null; entry.retryForMs = null; }],
    ];
    for (const [name, corrupt] of cases) {
      const entry = JSON.parse(original) as Record<string, unknown>;
      corrupt(entry);
      replace.run(JSON.stringify(entry), first.lease.id);
      // Keep version 2: the write-version guard is not a record validator.
      assert.equal(JSON.parse(String(select.get(first.lease.id)!.entry)).version, 2);
      let callbackInvoked = false;
      assert.throws(() => store.transact(first.lease.id, () => {
        callbackInvoked = true;
        return { value: 'grant' };
      }), /Corrupt journal entry/, name);
      assert.equal(callbackInvoked, false, `${name}: storage exposed corrupt state`);
      assert.throws(() => journal.begin(intent), /Corrupt journal entry/, name);
      replace.run(original, first.lease.id);
      assert.deepEqual(journal.begin(intent), { kind: 'busy', leaseUntil: 105 }, name);
    }
    now = 105;
    const recovered = acquire(journal);
    assert.equal(recovered.retry, true);
    assert.equal(recovered.retryStartBefore, 120);
  } finally {
    raw.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface LegacyEntry {
  version: 1;
  id: string;
  fingerprint: string;
  recovery: 'manual' | 'idempotent';
  state: 'pending' | 'completed' | 'indeterminate';
  epoch: number;
  executor: string;
  leaseUntil: number;
  result: string | null;
}

function legacyEntry(key: string, recovery: LegacyEntry['recovery'], state: LegacyEntry['state'] = 'pending'): LegacyEntry {
  // Frozen v1 wire format. These simple JSON values have a known byte encoding;
  // compatibility fixtures deliberately do not call the current serializer.
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    version: 1, id: digest(JSON.stringify(['legacy-window', key])),
    fingerprint: digest(JSON.stringify(['append', { units: 7 }, recovery])),
    recovery, state, epoch: 4, executor: `legacy-${key}`, leaseUntil: 110,
    result: state === 'completed' ? '{"receipt":1}' : null,
  };
}

function legacyIntent(key: string, retryForMs = 20): Intent {
  return { scope: 'legacy-window', key, tool: 'append', input: { units: 7 }, recovery: 'idempotent', retryForMs };
}

function withLegacyDatabase(entries: LegacyEntry[], run: (path: string, raw: DatabaseSync) => void): void {
  const directory = temporaryDirectory();
  const path = join(directory, 'journal.sqlite');
  const raw = new DatabaseSync(path);
  try {
    raw.exec('CREATE TABLE journal_meta (version INTEGER NOT NULL) STRICT; INSERT INTO journal_meta VALUES (1); CREATE TABLE tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT;');
    for (const entry of entries) raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run(entry.id, JSON.stringify(entry));
    run(path, raw);
  } finally { raw.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('v1 migration preserves receipts and treats unknown retry retention conservatively', () => {
  const live = legacyEntry('live', 'idempotent');
  const expired = legacyEntry('expired', 'idempotent');
  const completed = legacyEntry('completed', 'idempotent', 'completed');
  const manual = legacyEntry('manual', 'manual', 'indeterminate');
  withLegacyDatabase([live, expired, completed, manual], (path, raw) => {
    const store = new SqliteStore(path);
    let now = 100;
    const journal = new Journal(store, () => now);
    try {
      assert.deepEqual(raw.prepare('SELECT version FROM journal_meta').all().map(row => row.version), [2]);
      for (const row of raw.prepare('SELECT entry FROM tool_journal').all()) {
        const migrated = JSON.parse(String(row.entry));
        assert.equal(migrated.version, 2);
        assert.equal(migrated.firstAcquiredAt, null);
        assert.equal(migrated.retryForMs, null);
        assert.equal(migrated.retryStartBefore, null);
      }
      assert.deepEqual(journal.begin(legacyIntent('live')), { kind: 'busy', leaseUntil: 110 });
      const oldLease: Lease = { id: live.id, epoch: live.epoch, executor: live.executor };
      assert.equal(journal.complete(oldLease, { receipt: 2 }).kind, 'completed');
      now = 110;
      assert.deepEqual(journal.begin(legacyIntent('expired', 10_000)), { kind: 'indeterminate' });
      assert.deepEqual(journal.begin(legacyIntent('completed')), { kind: 'replay', result: { receipt: 1 } });
      assert.deepEqual(journal.begin(legacyIntent('completed', 40)), { kind: 'replay', result: { receipt: 1 } });
      assert.deepEqual(journal.begin(legacyIntent('live')), { kind: 'replay', result: { receipt: 2 } });
      const manualIntent: Intent = { scope: 'legacy-window', key: 'manual', tool: 'append', input: { units: 7 }, recovery: 'manual' };
      assert.deepEqual(journal.begin(manualIntent), { kind: 'indeterminate' });
      assert.equal(journal.settle(legacyIntent('expired'), { receipt: 3 }), 'settled');
    } finally { store.close(); }
    const reopened = new SqliteStore(path);
    try {
      assert.deepEqual(new Journal(reopened, () => 1_000).begin(legacyIntent('completed')), { kind: 'replay', result: { receipt: 1 } });
    } finally { reopened.close(); }
  });
});

test('a malformed v1 row rolls back every migrated row, schema version, and trigger', () => {
  const good = legacyEntry('good', 'idempotent');
  const broken = legacyEntry('broken', 'manual');
  withLegacyDatabase([good, broken], (path, raw) => {
    raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?').run(JSON.stringify({ ...broken, extra: 'not-a-v1-field' }), broken.id);
    const before = raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all();
    assert.throws(() => new SqliteStore(path), /Corrupt|[Mm]igrat|[Ll]egacy/);
    assert.deepEqual(raw.prepare('SELECT version FROM journal_meta').all().map(row => row.version), [1]);
    assert.deepEqual(raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all(), before);
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all(), []);
    raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?').run(JSON.stringify(broken), broken.id);
    const repaired = new SqliteStore(path);
    try { assert.deepEqual(raw.prepare('SELECT version FROM journal_meta').all().map(row => row.version), [2]); }
    finally { repaired.close(); }
  });
});

test('failure after the migration updates records rolls back records and schema together', () => {
  const pending = legacyEntry('pending', 'idempotent');
  const completed = legacyEntry('completed', 'manual', 'completed');
  withLegacyDatabase([pending, completed], (path, raw) => {
    const before = raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all();
    raw.exec(`CREATE TRIGGER test_fail_migration BEFORE UPDATE ON journal_meta
      WHEN NEW.version = 2 BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM tool_journal WHERE json_extract(entry, '$.version') IS NOT 2
        ) THEN RAISE(ABORT, 'injected failure after record update')
        ELSE RAISE(ABORT, 'metadata update attempted before records') END;
      END;`);
    assert.throws(() => new SqliteStore(path), /injected failure after record update/);
    assert.deepEqual(raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all(), before);
    assert.deepEqual(raw.prepare('SELECT version FROM journal_meta').all().map(row => row.version), [1]);
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map(row => row.name), ['test_fail_migration']);
    raw.exec('DROP TRIGGER test_fail_migration');
    const recovered = new SqliteStore(path);
    try {
      assert.deepEqual(raw.prepare('SELECT version FROM journal_meta').all().map(row => row.version), [2]);
      for (const row of raw.prepare('SELECT entry FROM tool_journal').all()) {
        assert.equal(JSON.parse(String(row.entry)).version, 2);
      }
      const value: Intent = { scope: 'legacy-window', key: 'completed', tool: 'append', input: { units: 7 }, recovery: 'manual' };
      assert.deepEqual(new Journal(recovered, () => 120).begin(value), { kind: 'replay', result: { receipt: 1 } });
    } finally { recovered.close(); }
  });
});

test('migration normalizes legacy duplicate JSON members with the same parser used for validation', () => {
  const completed = legacyEntry('duplicate-version', 'idempotent', 'completed');
  withLegacyDatabase([completed], (path, raw) => {
    // v1's JSON.parse reads the last member. SQLite json_set would change the
    // first one and leave a version-1 member behind after an apparent migration.
    raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?')
      .run('{"version":9,' + JSON.stringify(completed).slice(1), completed.id);
    const store = new SqliteStore(path);
    try {
      const encoded = String(raw.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(completed.id)!.entry);
      assert.equal((encoded.match(/"version":/g) ?? []).length, 1);
      assert.equal(JSON.parse(encoded).version, 2);
      assert.deepEqual(new Journal(store, () => 1_000).begin(legacyIntent('duplicate-version')),
        { kind: 'replay', result: { receipt: 1 } });
    } finally { store.close(); }
  });
});

test('migration does not skip an empty corrupted identity during keyset iteration', () => {
  const good = legacyEntry('valid', 'idempotent');
  withLegacyDatabase([good], (path, raw) => {
    raw.prepare('INSERT INTO tool_journal VALUES (?, ?)').run('', JSON.stringify({ ...good, id: '' }));
    const before = raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all();
    assert.throws(() => new SqliteStore(path), /Corrupt journal entry/);
    assert.deepEqual(raw.prepare('SELECT id, entry FROM tool_journal ORDER BY id').all(), before);
    assert.equal(raw.prepare('SELECT version FROM journal_meta').get()!.version, 1);
  });
});

test('already-open legacy connections cannot insert or restore v1-format rows after migration', () => {
  const existing = legacyEntry('existing', 'idempotent');
  withLegacyDatabase([existing], (path, legacyConnection) => {
    // Prepare the statements while the legacy database is still version 1.
    const oldInsert = legacyConnection.prepare('INSERT INTO tool_journal VALUES (?, ?)');
    const oldUpdate = legacyConnection.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?');
    const store = new SqliteStore(path);
    try {
      const another = legacyEntry('another', 'idempotent');
      assert.throws(() => oldInsert.run(another.id, JSON.stringify(another)));
      assert.throws(() => oldUpdate.run(JSON.stringify(existing), existing.id));
      assert.equal(legacyConnection.prepare('SELECT count(*) AS count FROM tool_journal').get()!.count, 1);
      const persisted = JSON.parse(String(legacyConnection.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(existing.id)!.entry));
      assert.equal(persisted.version, 2);
      // The old constructor's version-1 precondition is no longer satisfied.
      assert.notEqual(legacyConnection.prepare('SELECT version FROM journal_meta').get()!.version, 1);
    } finally { store.close(); }
  });
});

class ExpiringProvider {
  calls = 0;
  effects = 0;
  private readonly receipts = new Map<string, { until: number; receipt: number }>();
  constructor(private readonly retentionMs: number) {}
  send(key: string, now: number): { receipt: number } {
    this.calls++;
    const prior = this.receipts.get(key);
    if (prior && now < prior.until) return { receipt: prior.receipt };
    const receipt = ++this.effects;
    this.receipts.set(key, { until: now + this.retentionMs, receipt });
    return { receipt };
  }
}

test('expired admission refuses a new request even if the provider has forgotten the key', () => {
  withRuntime('sqlite', runtime => {
    const provider = new ExpiringProvider(20);
    const first = acquire(runtime.journal);
    provider.send(first.lease.id, runtime.now); // The receipt never reaches the journal.
    runtime.now = 120;
    runtime.reopen();
    const recovery = runtime.journal.begin(intent);
    if (recovery.kind === 'acquired') provider.send(recovery.lease.id, runtime.now);
    assert.deepEqual(recovery, { kind: 'indeterminate' });
    assert.equal(provider.calls, 1);
    assert.equal(provider.effects, 1);
  });
});

test('counterexample: admission before the cutoff cannot stop a delayed request reaching an expired provider key', () => {
  withRuntime('sqlite', runtime => {
    const provider = new ExpiringProvider(20);
    const first = acquire(runtime.journal);
    provider.send(first.lease.id, 100);
    runtime.now = 119;
    const retry = acquire(runtime.journal);
    assert.equal(retry.retryStartBefore, 120);
    // The executor pauses, or its request queues after its final local check.
    // Even a valid lease and stable key cannot enforce the remote arrival time.
    runtime.now = 121;
    const receipt = provider.send(retry.lease.id, runtime.now);
    assert.equal(provider.effects, 2);
    assert.equal(runtime.journal.complete(retry.lease, receipt).kind, 'completed');
    assert.equal(provider.calls, 2);
  });
});
