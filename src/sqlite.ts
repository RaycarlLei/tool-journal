import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { decodeEntry, encodeEntry, MAX_RECORD_BYTES, validateChange, type Store, type Entry, type Change } from './record.js';

// octet_length(column) reads size metadata without loading the whole value.
// SQLite counts in the database encoding; UTF-16 can take twice the UTF-8
// budget. The decoder still enforces the exact UTF-8 limit after this guard.
const recordProjection = `typeof(entry) AS storageType,
  CASE WHEN typeof(entry) = 'text' AND octet_length(entry) <= ${2 * MAX_RECORD_BYTES}
  THEN entry END AS entry`;
const migrationProjection = `CASE WHEN typeof(id) = 'text' AND octet_length(id) <= 128
  THEN id END AS id, ${recordProjection}`;

function decodeRow(row: Record<string, unknown>, id: string, version: 1 | 2 = 2): Entry {
  if (row.storageType !== 'text') throw new Error('Corrupt journal entry: invalid storage type');
  if (typeof row.entry !== 'string') throw new Error('Corrupt journal entry: oversized record');
  return decodeEntry(row.entry, id, version);
}

/** Local-disk, same-host coordination. Do not put the database on a network filesystem. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private inTransaction = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec('BEGIN IMMEDIATE');
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('journal_meta', 'tool_journal')").all();
      if (tables.length === 0) {
        this.db.exec('CREATE TABLE journal_meta (version INTEGER NOT NULL) STRICT; INSERT INTO journal_meta VALUES (2); CREATE TABLE tool_journal (id TEXT PRIMARY KEY, entry TEXT NOT NULL) STRICT;');
      } else if (tables.length !== 2) {
        // Recreating a missing records table would forget completed effects.
        throw new Error('Unsupported journal schema: missing table');
      }
      const versions = this.db.prepare(`SELECT CASE WHEN typeof(version) = 'integer' AND version IN (1, 2)
        THEN version END AS version FROM journal_meta LIMIT 2`).all();
      if (versions.length !== 1 || (versions[0]!.version !== 1 && versions[0]!.version !== 2)) throw new Error('Unsupported journal schema');
      if (versions[0]?.version === 1) {
        // Keyset iteration bounds memory without updating beneath an active cursor.
        // Decode and re-encode with one JSON parser; SQL JSON functions can resolve
        // duplicate object keys differently. Any bad row rolls back every write.
        const read = this.db.prepare(`SELECT ${migrationProjection} FROM tool_journal
          WHERE tool_journal.id > ? ORDER BY tool_journal.id LIMIT 1`);
        const write = this.db.prepare('UPDATE tool_journal SET entry = ? WHERE id = ?');
        let row = this.db.prepare(`SELECT ${migrationProjection} FROM tool_journal ORDER BY tool_journal.id LIMIT 1`).get();
        while (row) {
          if (typeof row.id !== 'string') throw new Error('Corrupt journal entry: invalid identity');
          const id = row.id;
          const migrated = decodeRow(row, id, 1);
          write.run(encodeEntry(migrated, id), id);
          row = read.get(id);
        }
        this.db.exec('UPDATE journal_meta SET version = 2');
      }
      // A v1 process that already opened the database does not recheck metadata.
      // Reject its writes too. This does not cancel an external request it sent.
      for (const operation of ['INSERT', 'UPDATE'] as const) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS tool_journal_v2_${operation.toLowerCase()}
          BEFORE ${operation} ON tool_journal
          WHEN CASE WHEN json_valid(NEW.entry) THEN json_extract(NEW.entry, '$.version') IS 2 ELSE 0 END = 0
          BEGIN SELECT RAISE(ABORT, 'Unsupported journal entry version'); END;`);
      }
      this.select = this.db.prepare(`SELECT ${recordProjection} FROM tool_journal WHERE id = ?`);
      this.upsert = this.db.prepare('INSERT INTO tool_journal VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry');
      this.db.exec('COMMIT');
    } catch (error) {
      this.abort(error, true);
    }
  }
  read(id: string): Entry | undefined {
    if (this.inTransaction) throw new Error('Nested journal transaction');
    // One SELECT keeps the size/type guards and payload in the same committed
    // snapshot. A separate preflight query would race another connection.
    const row = this.select.get(id);
    return row ? decodeRow(row, id) : undefined;
  }
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T {
    if (this.inTransaction) throw new Error('Nested journal transaction');
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const row = this.select.get(id);
      const { value, next } = validateChange(change(row ? decodeRow(row, id) : undefined));
      if (next !== undefined) {
        this.upsert.run(id, encodeEntry(next, id));
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
