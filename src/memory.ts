import { decodeEntry, type Store, type Entry, type Change } from './record.js';

/** Test adapter. No durability and no coordination across processes. */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, string>();
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T {
    const raw = this.entries.get(id);
    const { value, next } = change(raw === undefined ? undefined : decodeEntry(raw, id));
    if (next) this.entries.set(id, JSON.stringify(next));
    return value;
  }
}
