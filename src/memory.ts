import { decodeEntry, encodeEntry, validateChange, type Store, type Entry, type Change } from './record.js';

/** Test adapter. No durability and no coordination across processes. */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, string>();
  private inTransaction = false;
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T {
    if (this.inTransaction) throw new Error('Nested journal transaction');
    this.inTransaction = true;
    try {
      const raw = this.entries.get(id);
      const { value, next } = validateChange(change(raw === undefined ? undefined : decodeEntry(raw, id)));
      if (next !== undefined) this.entries.set(id, encodeEntry(next, id));
      return value;
    } finally { this.inTransaction = false; }
  }
}
