export type Recovery = 'idempotent' | 'manual';

export interface Entry {
  version: 1;
  id: string;
  fingerprint: string;
  recovery: Recovery;
  state: 'pending' | 'completed' | 'indeterminate';
  epoch: number;
  executor: string;
  leaseUntil: number;
  result: string | null;
}

/** Invalid persisted state must stop execution, never be treated as an empty journal. */
export function decodeEntry(raw: string, id: string): Entry {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) throw new Error('Corrupt journal entry');
  const e = v as Record<string, unknown>;
  if (e.version !== 1 || e.id !== id || !/^[a-f0-9]{64}$/.test(String(e.fingerprint)) ||
      !['idempotent', 'manual'].includes(String(e.recovery)) ||
      !['pending', 'completed', 'indeterminate'].includes(String(e.state)) ||
      !Number.isSafeInteger(e.epoch) || Number(e.epoch) < 1 ||
      typeof e.executor !== 'string' || e.executor.length === 0 ||
      !Number.isSafeInteger(e.leaseUntil) || Number(e.leaseUntil) < 0 ||
      (e.state === 'completed' ? typeof e.result !== 'string' : e.result !== null)) {
    throw new Error('Corrupt journal entry');
  }
  if (e.state === 'completed') JSON.parse(e.result as string);
  return e as unknown as Entry;
}

export interface Change<T> { value: T; next?: Entry }
export interface Store {
  /** Run a synchronous read/modify/write atomically. Throwing rolls back. */
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T;
}
