import { randomUUID } from 'node:crypto';
import { canonical, digest, type Json } from './json.js';
import type { Entry, Recovery, Store } from './record.js';

export interface Intent {
  scope: string;
  key: string;
  tool: string;
  input: Json;
  /** Idempotent means the downstream enforces this key for the entire retry horizon. */
  recovery: Recovery;
}
export interface Lease { readonly id: string; readonly epoch: number; readonly executor: string }
export type Begin =
  | { kind: 'acquired'; lease: Lease; retry: boolean }
  | { kind: 'replay'; result: Json }
  | { kind: 'busy'; leaseUntil: number }
  | { kind: 'conflict' }
  | { kind: 'indeterminate' };
export type Completion = { kind: 'completed' | 'replayed' | 'stale' | 'conflict' };

function identity(intent: Intent): { id: string; fingerprint: string } {
  for (const text of [intent.scope, intent.key, intent.tool]) {
    if (typeof text !== 'string' || text.length === 0 || text.length > 512) throw new TypeError('Invalid intent identifier');
  }
  if (intent.recovery !== 'idempotent' && intent.recovery !== 'manual') throw new TypeError('Invalid recovery contract');
  return {
    id: digest(canonical([intent.scope, intent.key])),
    fingerprint: digest(canonical([intent.tool, intent.input, intent.recovery])),
  };
}

function owns(entry: Entry, lease: Lease): boolean {
  return entry.id === lease.id && entry.epoch === lease.epoch && entry.executor === lease.executor;
}

export class Journal {
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Clock must return nonnegative integer milliseconds');
    return now;
  }
  private deadline(now: number, duration: number): number {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86_400_000 ||
        !Number.isSafeInteger(now + duration)) throw new TypeError('Lease must be 1 ms to 24 hours');
    return now + duration;
  }

  begin(intent: Intent, leaseMs = 30_000): Begin {
    const { id, fingerprint } = identity(intent);
    return this.store.transact<Begin>(id, entry => {
      // Read time after acquiring the storage lock; lock contention may outlast a lease.
      const now = this.now();
      const leaseUntil = this.deadline(now, leaseMs);
      if (entry) {
        if (entry.fingerprint !== fingerprint) return { value: { kind: 'conflict' } };
        if (entry.state === 'completed') return { value: { kind: 'replay', result: JSON.parse(entry.result!) as Json } };
        if (entry.state === 'indeterminate') return { value: { kind: 'indeterminate' } };
        if (entry.leaseUntil > now) return { value: { kind: 'busy', leaseUntil: entry.leaseUntil } };
        if (entry.recovery === 'manual') return {
          value: { kind: 'indeterminate' }, next: { ...entry, state: 'indeterminate' },
        };
      }
      const epoch = (entry?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('Execution epoch exhausted');
      const executor = randomUUID();
      return {
        value: { kind: 'acquired', lease: { id, epoch, executor }, retry: entry !== undefined },
        next: { version: 1, id, fingerprint, recovery: intent.recovery, state: 'pending', epoch, executor, leaseUntil, result: null },
      };
    });
  }

  complete(lease: Lease, result: Json): Completion {
    const encoded = canonical(result);
    return this.store.transact<Completion>(lease.id, entry => {
      if (!entry || !owns(entry, lease)) return { value: { kind: 'stale' } };
      if (entry.state === 'completed') return { value: { kind: entry.result === encoded ? 'replayed' : 'conflict' } };
      if (entry.state !== 'pending' || entry.leaseUntil <= this.now()) return { value: { kind: 'stale' } };
      return { value: { kind: 'completed' }, next: { ...entry, state: 'completed', result: encoded } };
    });
  }

  renew(lease: Lease, leaseMs = 30_000): boolean {
    return this.store.transact(lease.id, entry => {
      const now = this.now();
      const deadline = this.deadline(now, leaseMs);
      if (!entry || !owns(entry, lease) || entry.state !== 'pending' || entry.leaseUntil <= now) return { value: false };
      return { value: true, next: { ...entry, leaseUntil: Math.max(entry.leaseUntil, deadline) } };
    });
  }

  /** Call only after quiescing old executors and independently verifying the downstream receipt. */
  settle(intent: Intent, verifiedResult: Json): 'settled' | 'replayed' | 'conflict' | 'not_indeterminate' {
    const { id, fingerprint } = identity(intent);
    const result = canonical(verifiedResult);
    return this.store.transact(id, entry => {
      if (!entry) return { value: 'not_indeterminate' };
      if (entry.fingerprint !== fingerprint) return { value: 'conflict' };
      if (entry.state === 'completed') return { value: entry.result === result ? 'replayed' : 'conflict' };
      if (entry.state !== 'indeterminate') return { value: 'not_indeterminate' };
      return { value: 'settled', next: { ...entry, state: 'completed', result } };
    });
  }
}
