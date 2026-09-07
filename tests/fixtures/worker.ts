import { DatabaseSync } from 'node:sqlite';
import { Journal, SqliteStore, type Json } from '../../src/index.js';

const [journalPath, ledgerPath, strategy, phase, time] = process.argv.slice(2) as [string, string, string, string, string];
const now = Number(time);
async function report(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => process.send!(value, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve()));
}
async function pause(at: string): Promise<void> {
  if (phase === at) {
    await report({ kind: 'paused', phase: at });
    await new Promise(() => setInterval(() => {}, 60_000));
  }
}

const store = new SqliteStore(journalPath);
const ledger = new DatabaseSync(ledgerPath, { timeout: 5_000 });
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects (receipt INTEGER PRIMARY KEY, action TEXT, units INTEGER NOT NULL) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS effect_key ON effects(action); CREATE TABLE IF NOT EXISTS checkpoint (result TEXT NOT NULL) STRICT;');
const journal = new Journal(store, () => now);
const intent = { scope: 'synthetic-ledger', key: 'append-7', tool: 'append', input: { units: 7 }, recovery: strategy === 'journal-manual' ? 'manual' as const : 'idempotent' as const };

try {
  const begun = strategy.startsWith('journal') || strategy === 'claim' ? journal.begin(intent, 10) : undefined;
  if (strategy === 'claim') {
    await report(begun);
  } else if (begun && begun.kind !== 'acquired') {
    await report(begun);
  } else {
    const checkpoint = strategy === 'checkpoint' ? ledger.prepare('SELECT result FROM checkpoint').get() : undefined;
    if (checkpoint) {
      await report({ kind: 'replay', result: JSON.parse(String(checkpoint.result)) });
    } else {
      await pause('before-effect');
      const action = strategy === 'journal-idempotent' && begun?.kind === 'acquired' ? begun.lease.id : null;
      ledger.exec('BEGIN IMMEDIATE');
      let result: Json;
      try {
        ledger.prepare('INSERT OR IGNORE INTO effects(action, units) VALUES (?, 7)').run(action);
        const receipt = action === null ? ledger.prepare('SELECT last_insert_rowid() AS receipt').get() : ledger.prepare('SELECT receipt FROM effects WHERE action = ?').get(action);
        result = { receipt: Number(receipt!.receipt), units: 7 };
        ledger.exec('COMMIT');
      } catch (error) { ledger.exec('ROLLBACK'); throw error; }
      await pause('after-effect');
      const completed = begun?.kind === 'acquired' ? journal.complete(begun.lease, result) : { kind: 'completed' };
      if (strategy === 'checkpoint') ledger.prepare('INSERT INTO checkpoint VALUES (?)').run(JSON.stringify(result));
      await pause('after-complete');
      await report({ ...completed, result });
    }
  }
} finally { ledger.close(); store.close(); process.disconnect!(); }
