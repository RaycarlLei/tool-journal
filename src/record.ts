import { canonical, MAX_JSON_BYTES } from './json.js';
import { types } from 'node:util';

export type Recovery = 'idempotent' | 'manual';

export interface Entry {
  version: 2;
  id: string;
  fingerprint: string;
  recovery: Recovery;
  state: 'pending' | 'completed' | 'indeterminate';
  epoch: number;
  executor: string;
  leaseUntil: number;
  result: string | null;
  /** null only for a migrated v1 record whose first acquisition is unknown. */
  firstAcquiredAt: number | null;
  /** null for manual recovery or a migrated idempotent record with no known window. */
  retryForMs: number | null;
  retryStartBefore: number | null;
}

/** Invalid persisted state must stop execution, never be treated as an empty journal. */
export function decodeEntry(raw: string, id: string, version: 1 | 2 = 2): Entry {
  // A canonical result is nested as a JSON string, which can double its byte size.
  const limit = 2 * MAX_JSON_BYTES + 4_096;
  if (raw.length > limit || Buffer.byteLength(raw) > limit) throw new Error('Corrupt journal entry: oversized record');
  let v: unknown;
  try { v = JSON.parse(raw); }
  catch (cause) { throw new Error('Corrupt journal entry: invalid JSON', { cause }); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('Corrupt journal entry');
  const e = v as Record<string, unknown>;
  const fields = ['version', 'id', 'fingerprint', 'recovery', 'state', 'epoch', 'executor', 'leaseUntil', 'result'];
  if (version === 2) fields.push('firstAcquiredAt', 'retryForMs', 'retryStartBefore');
  if (Object.keys(e).length !== fields.length || fields.some(field => !Object.hasOwn(e, field)) ||
      e.version !== version || e.id !== id || typeof e.id !== 'string' || !/^[a-f0-9]{64}$/.test(e.id) ||
      typeof e.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(e.fingerprint) ||
      (e.recovery !== 'idempotent' && e.recovery !== 'manual') ||
      (e.state !== 'pending' && e.state !== 'completed' && e.state !== 'indeterminate') ||
      (version === 1 && e.state === 'indeterminate' && e.recovery !== 'manual') ||
      !Number.isSafeInteger(e.epoch) || Number(e.epoch) < 1 ||
      typeof e.executor !== 'string' || e.executor.length === 0 || e.executor.length > 512 ||
      !Number.isSafeInteger(e.leaseUntil) || Number(e.leaseUntil) < 0 ||
      (e.state === 'completed' ? typeof e.result !== 'string' : e.result !== null)) {
    throw new Error('Corrupt journal entry');
  }
  if (version === 2) {
    const firstKnown = Number.isSafeInteger(e.firstAcquiredAt) && Number(e.firstAcquiredAt) >= 0;
    if (firstKnown && Number(e.leaseUntil) <= Number(e.firstAcquiredAt)) {
      throw new Error('Corrupt journal entry: lease precedes first acquisition');
    }
    const unknownWindow = e.firstAcquiredAt === null && e.retryForMs === null && e.retryStartBefore === null;
    const boundedWindow = firstKnown && Number.isSafeInteger(e.retryForMs) && Number(e.retryForMs) > 0 &&
      Number.isSafeInteger(e.retryStartBefore) && Number(e.retryStartBefore) === Number(e.firstAcquiredAt) + Number(e.retryForMs);
    if (e.recovery === 'manual'
      ? ((!firstKnown && e.firstAcquiredAt !== null) || e.retryForMs !== null || e.retryStartBefore !== null)
      : (!unknownWindow && !boundedWindow)) throw new Error('Corrupt journal entry: invalid retry window');
  }
  if (e.state === 'completed') {
    try {
      if (canonical(JSON.parse(e.result as string)) !== e.result) throw new Error('Noncanonical result');
    } catch (cause) {
      throw new Error('Corrupt journal entry: invalid result', { cause });
    }
  }
  return (version === 1
    ? { ...e, version: 2, firstAcquiredAt: null, retryForMs: null, retryStartBefore: null }
    : e) as unknown as Entry;
}

export function encodeEntry(entry: Entry, id: string): string {
  const raw = JSON.stringify(entry);
  decodeEntry(raw, id);
  return raw;
}

export interface Change<T> { value: T; next?: Entry }
export function validateChange<T>(change: Change<T>): Change<T> {
  if (types.isPromise(change)) {
    // Misused async callbacks may reject after we throw; observe that rejection.
    // This cannot undo arbitrary work the callback itself already performed.
    void change.catch(() => {});
    throw new TypeError('Journal transaction callback must be synchronous');
  }
  if (typeof change !== 'object' || change === null || !Object.hasOwn(change, 'value')) {
    throw new TypeError('Journal transaction callback must return a Change');
  }
  return change;
}
export interface Store {
  /** Run a synchronous read/modify/write atomically. Throwing rolls back; nested transactions are rejected. */
  transact<T>(id: string, change: (entry: Entry | undefined) => Change<T>): T;
}
