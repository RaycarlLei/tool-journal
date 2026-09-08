import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, MemoryStore, SqliteStore, type Intent } from '../src/index.js';
import { canonical, MAX_JSON_BYTES } from '../src/json.js';
import type { Change, Entry } from '../src/record.js';

const intent: Intent = {
  scope: 'integrity-test', key: 'one-effect', tool: 'append', input: { units: 1 }, recovery: 'manual',
};

function withDatabase(run: (store: SqliteStore, raw: DatabaseSync) => void): void {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'journal-integrity-'));
  const verifiedDirectory = realpathSync(directory);
  assert.equal(dirname(verifiedDirectory), root);
  const path = join(verifiedDirectory, 'journal.sqlite');
  let store: SqliteStore | undefined;
  let raw: DatabaseSync | undefined;
  try {
    store = new SqliteStore(path);
    raw = new DatabaseSync(path);
    run(store, raw);
  } finally {
    try { raw?.close(); }
    finally {
      try { store?.close(); }
      finally { rmSync(verifiedDirectory, { recursive: true, force: true }); }
    }
  }
}

function storedEntry(raw: DatabaseSync, id: string): Record<string, unknown> {
  const row = raw.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(id);
  assert.ok(row);
  assert.equal(typeof row.entry, 'string');
  return JSON.parse(row.entry as string) as Record<string, unknown>;
}

const malformedFields: Record<string, Record<string, unknown>> = {
  'array recovery that string-coerces to manual': { recovery: ['manual'] },
  'object recovery': { recovery: { value: 'manual' } },
  'null recovery': { recovery: null },
  'array state that string-coerces to pending': { state: ['pending'] },
  'array fingerprint': { fingerprint: ['a'.repeat(64)] },
  'unknown field': { unexpected: true },
  'indeterminate idempotent action': { recovery: 'idempotent', state: 'indeterminate' },
  'pending action with a receipt': { result: 'null' },
  'completed action without a receipt': { state: 'completed', result: null },
  'string epoch': { epoch: '1' },
  'exhausted numeric precision': { epoch: Number.MAX_SAFE_INTEGER + 1 },
  'negative deadline': { leaseUntil: -1 },
  'empty executor': { executor: '' },
  'oversized executor': { executor: 'x'.repeat(513) },
  'mismatched identity': { id: '0'.repeat(64) },
};

for (const [name, patch] of Object.entries(malformedFields)) {
  test(`SQLite refuses corrupted state before manual reacquisition: ${name}`, () => {
    withDatabase((store, raw) => {
      let now = 0;
      const journal = new Journal(store, () => now);
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
      const original = storedEntry(raw, begun.lease.id);
      const corrupted = JSON.stringify({ ...original, ...patch });
      raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?').run(corrupted, begun.lease.id);
      now = 10;

      assert.throws(() => journal.begin(intent, 10), /Corrupt journal entry/);
      assert.equal(raw.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(begun.lease.id)?.entry, corrupted);

      // A failed read must release its transaction; restoring the row exposes the
      // original uncertainty, rather than a new execution or a leaked lock.
      raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?').run(JSON.stringify(original), begun.lease.id);
      assert.equal(journal.begin(intent, 10).kind, 'indeterminate');
    });
  });
}

const invalidResults: Record<string, string> = {
  'nonfinite exponent': '1e400',
  'noncanonical spacing': ' { "receipt": 1 } ',
  'duplicate object keys': '{"receipt":1,"receipt":2}',
  'noncanonical key order': '{"z":1,"a":2}',
  'oversized JSON value': JSON.stringify('a'.repeat(MAX_JSON_BYTES)),
  'excessive nesting': '['.repeat(65) + 'null' + ']'.repeat(65),
  'invalid JSON': '{',
};

for (const [name, result] of Object.entries(invalidResults)) {
  test(`SQLite refuses corrupted completed result: ${name}`, () => {
    withDatabase((store, raw) => {
      const journal = new Journal(store, () => 0);
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
      assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
      const original = storedEntry(raw, begun.lease.id);
      raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?')
        .run(JSON.stringify({ ...original, result }), begun.lease.id);

      assert.throws(() => journal.begin(intent, 10), /Corrupt journal entry/);
      assert.throws(() => journal.complete(begun.lease, { receipt: 1 }), /Corrupt journal entry/);
      assert.throws(() => journal.settle(intent, { receipt: 1 }), /Corrupt journal entry/);
    });
  });
}

test('SQLite accepts a maximum-size escaped receipt and rejects an oversized outer record', () => {
  withDatabase((store, raw) => {
    const journal = new Journal(store, () => 0);
    const begun = journal.begin(intent, 10);
    assert.equal(begun.kind, 'acquired');
    if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
    // Backslashes double once in the receipt and again in its enclosing row.
    const result = '\\'.repeat((MAX_JSON_BYTES - 2) / 2);
    assert.equal(Buffer.byteLength(canonical(result)), MAX_JSON_BYTES);
    assert.equal(journal.complete(begun.lease, result).kind, 'completed');
    assert.deepEqual(journal.begin(intent), { kind: 'replay', result });
    const original = storedEntry(raw, begun.lease.id);
    const oversized = ' '.repeat(2 * MAX_JSON_BYTES + 4_097) + JSON.stringify(original);
    raw.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?').run(oversized, begun.lease.id);
    assert.throws(() => journal.begin(intent), /Corrupt journal entry: oversized record/);
  });
});

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: nested transactions cannot commit a claim and the adapter remains usable`, () => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const journal = new Journal(store, () => 0);
    try {
      assert.throws(() => store.transact('f'.repeat(64), () => {
        journal.begin(intent, 10);
        throw new Error('The nested claim must never return');
      }), /Nested journal transaction/);
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
      assert.equal(begun.retry, false);
      assert.equal(begun.lease.epoch, 1);
      assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
      assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
    } finally { if (store instanceof SqliteStore) store.close(); }
  });
}

for (const operation of ['constructor', 'transaction'] as const) {
  test(`SQLite ${operation} preserves the commit failure and closes after rollback failure`, t => {
    const store = operation === 'transaction' ? new SqliteStore(':memory:') : undefined;
    const primary = new Error('injected commit failure');
    const rollback = new Error('injected rollback failure');
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let observed: DatabaseSync | undefined;
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string): void {
      observed = this;
      if (sql === 'COMMIT') throw primary;
      if (sql === 'ROLLBACK') throw rollback;
      originalExec.call(this, sql);
    });
    t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync): void {
      closes++;
      originalClose.call(this);
    });
    try {
      assert.throws(() => {
        if (store) new Journal(store, () => 0).begin(intent, 10);
        else new SqliteStore(':memory:');
      }, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, primary);
        assert.deepEqual(error.errors, [primary, rollback]);
        return true;
      });
      assert.equal(closes, 1);
      assert.ok(observed);
      assert.equal(observed.isOpen, false);
      t.mock.restoreAll();
      if (store) {
        let entered = false;
        assert.throws(() => store.transact('f'.repeat(64), () => { entered = true; return { value: true }; }));
        assert.equal(entered, false);
      }
    } finally {
      t.mock.restoreAll();
      if (observed?.isOpen) originalClose.call(observed);
      store?.close();
    }
  });
}

test('SQLite rolls back a failed commit and permits the next claim when cleanup succeeds', t => {
  const store = new SqliteStore(':memory:');
  const primary = new Error('injected commit failure');
  const originalExec = DatabaseSync.prototype.exec;
  let failNextCommit = true;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string): void {
    if (sql === 'COMMIT' && failNextCommit) { failNextCommit = false; throw primary; }
    originalExec.call(this, sql);
  });
  try {
    const journal = new Journal(store, () => 0);
    assert.throws(() => journal.begin(intent, 10), error => error === primary);
    const begun = journal.begin(intent, 10);
    assert.equal(begun.kind, 'acquired');
    if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
    assert.equal(begun.retry, false);
    assert.equal(begun.lease.epoch, 1);
  } finally { t.mock.restoreAll(); store.close(); }
});

test('canonical encoding rejects an exponentially expanding shared DAG within bounded resources', () => {
  const moduleUrl = new URL('../src/json.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { canonical } from ${JSON.stringify(moduleUrl)};
    let value = 'leaf';
    for (let depth = 0; depth < 40; depth++) value = [value, value];
    assert.throws(() => canonical(value), /JSON exceeds 1 MiB/);
    process.stdout.write('bounded rejection');
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', script], {
    timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1_024, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'bounded rejection');
});

test('canonical encoding rejects proxies and accessors without executing user code', () => {
  let executed = 0;
  const trap = (): never => { executed++; throw new Error('must not execute'); };
  const proxy = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, get: trap });
  assert.throws(() => canonical(proxy), /Proxy/);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.throws(() => canonical(revoked.proxy), /Proxy/);
  assert.throws(() => canonical({ get value() { return trap(); } }), /accessor/);
  assert.equal(executed, 0);
});

test('canonical byte limits count UTF-8 and JSON escapes at the exact boundary', () => {
  const atLimit = [
    'a'.repeat(MAX_JSON_BYTES - 2),
    'é'.repeat((MAX_JSON_BYTES - 2) / 2),
    '😀'.repeat(Math.floor((MAX_JSON_BYTES - 2) / 4)) + 'ab',
    '\0'.repeat(Math.floor((MAX_JSON_BYTES - 2) / 6)) + 'ab',
  ];
  for (const value of atLimit) {
    const encoded = canonical(value);
    assert.equal(Buffer.byteLength(encoded), MAX_JSON_BYTES);
    assert.equal(JSON.parse(encoded), value);
    assert.throws(() => canonical(value + 'x'), /JSON exceeds 1 MiB/);
  }
});

test('canonical encoding preserves ordinary deterministic JSON and permits shared values', () => {
  const shared = { z: -0, a: ['😀', '\ud800', null, false, 1.25] };
  const value = { right: shared, left: shared };
  const expectedPart = '{"a":["😀","\\ud800",null,false,1.25],"z":0}';
  assert.equal(canonical(value), `{"left":${expectedPart},"right":${expectedPart}}`);
  assert.equal(canonical(JSON.parse('{"__proto__":1,"constructor":2}')), '{"__proto__":1,"constructor":2}');
  const nullPrototype: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  nullPrototype.value = shared;
  assert.equal(canonical(nullPrototype), canonical({ value: shared }));
  let nested: unknown = null;
  for (let depth = 0; depth < 64; depth++) nested = [nested];
  assert.doesNotThrow(() => canonical(nested));
  assert.throws(() => canonical([nested]), /depth 64/);
});

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: an async callback cannot report success or commit its eventual result`, async () => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const journal = new Journal(store, () => 0);
    try {
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
      let continued = false;
      const callback = async (entry: Entry | undefined) => {
        assert.ok(entry);
        await Promise.resolve();
        continued = true;
        return { value: 'saved', next: { ...entry, state: 'completed', result: 'null' } };
      };
      // Simulate a JavaScript consumer: TypeScript already rejects this callback.
      assert.throws(() => store.transact(begun.lease.id, callback as unknown as (entry: Entry | undefined) => Change<string>));
      await new Promise<void>(resolve => setImmediate(resolve));

      // Rejection cannot cancel arbitrary JavaScript. Only the returned change is
      // excluded from the transaction, even though the callback keeps running.
      assert.equal(continued, true);
      assert.equal(journal.begin(intent, 10).kind, 'busy');
      assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
      assert.deepEqual(journal.begin(intent), { kind: 'replay', result: { receipt: 1 } });
    } finally { if (store instanceof SqliteStore) store.close(); }
  });

  test(`${adapter}: malformed callback results fail closed and an explicit undefined value is valid`, () => {
    const store = adapter === 'memory' ? new MemoryStore() : new SqliteStore(':memory:');
    const journal = new Journal(store, () => 0);
    try {
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      if (begun.kind !== 'acquired') throw new Error('Expected acquisition');
      const entry = store.transact(begun.lease.id, current => ({ value: current }));
      assert.ok(entry);
      const completed: Entry = { ...entry, state: 'completed', result: 'null' };
      const malformed: unknown[] = [
        undefined, null, 0, 'wrong shape', [], {}, Object.create({ value: true }), { next: completed },
      ];
      for (const result of malformed) {
        assert.throws(() => store.transact(begun.lease.id, () => result as Change<unknown>));
        assert.equal(journal.begin(intent, 10).kind, 'busy');
      }
      const value = store.transact(begun.lease.id, () => ({ value: undefined, next: completed }));
      assert.equal(value, undefined);
      assert.deepEqual(journal.begin(intent), { kind: 'replay', result: null });
    } finally { if (store instanceof SqliteStore) store.close(); }
  });

  test(`${adapter}: rejecting an async callback observes its later rejection`, () => {
    const moduleUrl = new URL('../src/index.js', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { Journal, MemoryStore, SqliteStore } from ${JSON.stringify(moduleUrl)};
      const store = ${adapter === 'memory' ? 'new MemoryStore()' : "new SqliteStore(':memory:')"};
      const journal = new Journal(store, () => 0);
      const intent = ${JSON.stringify(intent)};
      const begun = journal.begin(intent, 10);
      assert.equal(begun.kind, 'acquired');
      try {
        assert.throws(() => store.transact(begun.lease.id, async () => {
          await Promise.resolve();
          throw new Error('injected asynchronous failure');
        }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(journal.begin(intent, 10).kind, 'busy');
        assert.equal(journal.complete(begun.lease, null).kind, 'completed');
        process.stdout.write('rejection observed; adapter reusable');
      } finally { if (store instanceof SqliteStore) store.close(); }
    `;
    // There is deliberately no process-level rejection handler: a forgotten
    // Promise observer must make this process fail under Node's strict policy.
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', script], {
      timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1_024, windowsHide: true,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'rejection observed; adapter reusable');
  });
}
