import { DatabaseSync } from 'node:sqlite';
import { Journal, SqliteStore, type Json } from '../../src/index.js';
import { canonical, digest } from '../../src/json.js';

const [journalPath, ledgerPath, strategy, phase, time] = process.argv.slice(2) as [string, string, string, string, string];
let now = Number(time);

async function report(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => process.send!(value, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve()));
}

async function pause(at: string): Promise<void> {
  if (phase !== at) return;
  // The parent either kills us or resumes this same executor after another one runs.
  await new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      process.off('message', resume);
      process.off('disconnect', disconnected);
    }
    function disconnected(): void {
      cleanup();
      reject(new Error('Parent disconnected while the executor was paused'));
    }
    function resume(message: unknown): void {
      const command = message as { kind?: string; now?: number };
      if (command.kind !== 'resume') return;
      cleanup();
      if (!Number.isSafeInteger(command.now) || command.now! < now) {
        reject(new Error('Resume time must be an integer at or after acquisition'));
        return;
      }
      now = command.now!;
      resolve();
    }
    process.on('message', resume);
    process.once('disconnect', disconnected);
    void report({ kind: 'paused', phase: at }).catch(error => { cleanup(); reject(error); });
  });
}

const usesJournal = strategy.startsWith('journal') || strategy === 'claim';
const store = usesJournal ? new SqliteStore(journalPath) : undefined;
const journal = store ? new Journal(store, () => now) : undefined;
const intent = { scope: 'synthetic-ledger', key: 'append-7', tool: 'append', input: { units: 7 }, recovery: strategy === 'journal-manual' ? 'manual' as const : 'idempotent' as const };
// Identical downstream identity in both deduplicating strategies. Keep this check
// separate from the journal so the baseline does not acquire or read journal state.
const downstreamKey = digest(canonical([intent.scope, intent.key]));
let ledger: DatabaseSync | undefined;

try {
  const begun = journal?.begin(intent, 10);
  if (strategy === 'claim' || (begun && begun.kind !== 'acquired')) {
    await report(begun);
  } else {
    ledger = new DatabaseSync(ledgerPath, { timeout: 5_000 });
    ledger.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS effects (receipt INTEGER PRIMARY KEY, action TEXT, units INTEGER NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS effect_key ON effects(action);
      CREATE TABLE IF NOT EXISTS calls (attempt INTEGER PRIMARY KEY, action TEXT, units INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoint (result TEXT NOT NULL) STRICT;
    `);
    const checkpoint = strategy === 'checkpoint' ? ledger.prepare('SELECT result FROM checkpoint').get() : undefined;
    if (checkpoint) {
      await report({ kind: 'replay', result: JSON.parse(String(checkpoint.result)) });
    } else {
      await pause('before-effect');
      const deduplicates = strategy === 'journal-idempotent' || strategy === 'downstream-idempotency-only';
      if (strategy === 'journal-idempotent' && begun?.kind === 'acquired' && begun.lease.id !== downstreamKey) {
        throw new Error('Journal and baseline must use the same downstream key');
      }
      const action = deduplicates ? downstreamKey : null;
      ledger.exec('BEGIN IMMEDIATE');
      let result: Json;
      try {
        // A call means the synthetic service accepted a request, even when its
        // idempotency key makes the durable effect a no-op.
        ledger.prepare('INSERT INTO calls(action, units) VALUES (?, 7)').run(action);
        ledger.prepare('INSERT INTO effects(action, units) VALUES (?, 7) ON CONFLICT(action) DO NOTHING').run(action);
        const receipt = action === null ? ledger.prepare('SELECT last_insert_rowid() AS receipt').get() : ledger.prepare('SELECT receipt FROM effects WHERE action = ?').get(action);
        result = { receipt: Number(receipt!.receipt), units: 7 };
        ledger.exec('COMMIT');
      } catch (error) { ledger.exec('ROLLBACK'); throw error; }
      if (phase === 'response-loss') {
        // Service commit succeeded, but the client receives no receipt. No
        // checkpoint or journal completion is permitted on this path.
        await report({ kind: 'response-lost' });
      } else {
        await pause('after-effect');
        const completed = begun?.kind === 'acquired' ? journal!.complete(begun.lease, result) : { kind: 'completed' };
        if (strategy === 'checkpoint') ledger.prepare('INSERT INTO checkpoint VALUES (?)').run(JSON.stringify(result));
        await pause('after-complete');
        await report({ ...completed, result });
      }
    }
  }
} finally {
  ledger?.close();
  store?.close();
  if (process.connected) process.disconnect!();
}
