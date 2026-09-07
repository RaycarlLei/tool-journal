import { DatabaseSync } from 'node:sqlite';
import { decodeEntry, type Store, type Entry, type Change } from './record.js';

/** Local-disk, same-host coordination. Do not put the database on a network filesystem. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
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
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT entry FROM tool_journal WHERE id = ?').get(id);
      const { value, next } = change(row ? decodeEntry(String(row.entry), id) : undefined);
      if (next) {
        this.db.prepare('INSERT INTO tool_journal VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry')
          .run(id, JSON.stringify(next));
      }
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
