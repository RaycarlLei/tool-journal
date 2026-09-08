import { DatabaseSync } from 'node:sqlite';
import { decodeEntry, encodeEntry, validateChange, type Store, type Entry, type Change } from './record.js';

/** Local-disk, same-host coordination. Do not put the database on a network filesystem. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('CREATE TABLE IF NOT EXISTS journal_meta (version INTEGER NOT NULL) STRICT');
      const versions = this.db.prepare('SELECT version FROM journal_meta').all();
      if (versions.length === 0) this.db.prepare('INSERT INTO journal_meta VALUES (1)').run();
      else if (versions.length !== 1 || versions[0]!.version !== 1) throw new Error('Unsupported journal schema');
      this.db.exec('CREATE TABLE IF NOT EXISTS tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT');
      this.db.exec('COMMIT');
    } catch (error) {
      this.abort(error, true);
    }
  }
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T {
    if (this.inTransaction) throw new Error('Nested journal transaction');
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.db.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(id);
      const { value, next } = validateChange(change(row ? decodeEntry(String(row.entry), id) : undefined));
      if (next !== undefined) {
        this.db.prepare('INSERT INTO tool_journal VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry')
          .run(id, encodeEntry(next, id));
      }
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.abort(error);
    } finally { this.inTransaction = false; }
  }
  private abort(error: unknown, close = false): never {
    const failures = [error];
    try { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
    catch (rollback) { failures.push(rollback); close = true; }
    // A connection whose rollback failed cannot be trusted for another claim.
    if (close) {
      try { this.db.close(); } catch (cleanup) { failures.push(cleanup); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Journal storage cleanup failed', { cause: error });
    throw error;
  }
  close(): void { if (this.db.isOpen) this.db.close(); }
}
