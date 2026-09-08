import { randomUUID } from 'node:crypto';
import { canonical, digest, type Json } from './json.js';
import type { Entry, Recovery, Store } from './record.js';

interface ActionIdentity {
  scope: string;
  key: string;
  tool: string;
  input: Json;
}
export type Intent = ActionIdentity & (
  | { recovery: 'manual'; retryForMs?: never }
  /** A fixed admission window from first acquisition, not a provider expiry guarantee. */
  | { recovery: 'idempotent'; retryForMs: number }
);
export interface Lease { readonly id: string; readonly epoch: number; readonly executor: string }
export type Begin =
  | { kind: 'acquired'; lease: Lease; retry: boolean; retryStartBefore: number | null }
  | { kind: 'replay'; result: Json }
  | { kind: 'busy'; leaseUntil: number }
  | { kind: 'conflict' }
  | { kind: 'indeterminate' };
export type Completion = { kind: 'completed' | 'replayed' | 'stale' | 'conflict' };

function identity(intent: Intent): { id: string; fingerprint: string; recovery: Recovery; retryForMs: number | null } {
  const { scope, key, tool, input, recovery, retryForMs } = intent;
  for (const text of [scope, key, tool]) {
    if (typeof text !== 'string' || text.length === 0 || text.length > 512) throw new TypeError('Invalid intent identifier');
  }
  if (recovery !== 'idempotent' && recovery !== 'manual') throw new TypeError('Invalid recovery contract');
  if (recovery === 'idempotent') {
    if (!Number.isSafeInteger(retryForMs) || retryForMs < 1) throw new TypeError('Retry window must be positive safe integer milliseconds');
  } else if (retryForMs !== undefined) throw new TypeError('Manual recovery cannot have a retry window');
  return {
    id: digest(canonical([scope, key])),
    // Preserve v1 identity/fingerprints so migration can replay known receipts.
    // The new policy is bound separately; it may never refresh an existing window.
    fingerprint: digest(canonical([tool, input, recovery])),
    recovery, retryForMs: retryForMs ?? null,
  };
}

function owns(entry: Entry, lease: Lease): boolean {
  return entry.id === lease.id && entry.epoch === lease.epoch && entry.executor === lease.executor;
}

function observedOutcome(entry: Entry, fingerprint: string, retryForMs: number | null): Begin | undefined {
  if (entry.fingerprint !== fingerprint) return { kind: 'conflict' };
  if (entry.retryForMs !== null && entry.retryForMs !== retryForMs) return { kind: 'conflict' };
  if (entry.state === 'completed') return { kind: 'replay', result: JSON.parse(entry.result!) as Json };
  if (entry.state === 'indeterminate') return { kind: 'indeterminate' };
  return undefined;
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
    const { id, fingerprint, recovery, retryForMs } = identity(intent);
    const snapshot = this.store.read?.(id);
    if (snapshot?.state === 'completed') {
      // A committed receipt authorizes no new execution. Its read can linearize
      // replay without waiting for an unrelated writer. Preserve argument checks.
      this.deadline(this.now(), leaseMs);
      return observedOutcome(snapshot, fingerprint, retryForMs)!;
    }
    return this.store.transact<Begin>(id, entry => {
      // Read time after acquiring the storage lock; lock contention may outlast a lease.
      const now = this.now();
      const leaseUntil = this.deadline(now, leaseMs);
      if (entry) {
        const observed = observedOutcome(entry, fingerprint, retryForMs);
        if (observed) return { value: observed };
        if (entry.leaseUntil > now) return { value: { kind: 'busy', leaseUntil: entry.leaseUntil } };
        if (entry.recovery === 'manual' || entry.retryStartBefore === null || now >= entry.retryStartBefore) return {
          value: { kind: 'indeterminate' }, next: { ...entry, state: 'indeterminate' },
        };
      }
      const epoch = (entry?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('Execution epoch exhausted');
      const executor = randomUUID();
      const firstAcquiredAt = entry ? entry.firstAcquiredAt : now;
      const retryStartBefore = entry ? entry.retryStartBefore : retryForMs === null ? null : now + retryForMs;
      if (retryStartBefore !== null && !Number.isSafeInteger(retryStartBefore)) {
        throw new TypeError('Retry admission deadline exceeds safe integer range');
      }
      return {
        value: { kind: 'acquired', lease: { id, epoch, executor }, retry: entry !== undefined, retryStartBefore },
        next: { version: 2, id, fingerprint, recovery, state: 'pending', epoch, executor, leaseUntil, result: null,
          firstAcquiredAt, retryForMs, retryStartBefore },
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
    const { id, fingerprint, retryForMs } = identity(intent);
    const result = canonical(verifiedResult);
    return this.store.transact(id, entry => {
      if (!entry) return { value: 'not_indeterminate' };
      if (entry.fingerprint !== fingerprint) return { value: 'conflict' };
      if (entry.retryForMs !== null && entry.retryForMs !== retryForMs) return { value: 'conflict' };
      if (entry.state === 'completed') return { value: entry.result === result ? 'replayed' : 'conflict' };
      if (entry.state !== 'indeterminate') return { value: 'not_indeterminate' };
      return { value: 'settled', next: { ...entry, state: 'completed', result } };
    });
  }
}
