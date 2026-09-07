import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Journal, MemoryStore, type Lease, type Intent } from '../src/index.js';

// A small behavioral oracle: one timeline, one slot, no journal internals imported.
test('seeded operation histories agree with an independent lease model', () => {
  const seed = 20260907;
  fc.assert(fc.property(
    fc.constantFrom('manual' as const, 'idempotent' as const),
    fc.array(fc.record({ op: fc.constantFrom('begin', 'tick', 'complete', 'old-complete', 'conflict'), dt: fc.integer({ min: 0, max: 12 }) }), { minLength: 1, maxLength: 100 }),
    (recovery, commands) => {
      let now = 0;
      let deadline = 0;
      let state: 'empty' | 'running' | 'done' | 'unknown' = 'empty';
      let current: Lease | undefined;
      const old: Lease[] = [];
      const journal = new Journal(new MemoryStore(), () => now);
      const intent: Intent = { scope: 'model', key: 'one', tool: 'write', input: 1, recovery };
      for (const c of commands) {
        if (c.op === 'tick') { now += c.dt; continue; }
        if (c.op === 'conflict') {
          if (state !== 'empty') assert.equal(journal.begin({ ...intent, input: 2 }).kind, 'conflict');
          continue;
        }
        if (c.op === 'old-complete') {
          for (const lease of old) assert.equal(journal.complete(lease, 42).kind, 'stale');
          continue;
        }
        if (c.op === 'complete') {
          if (!current) continue;
          const expected: string = state === 'done' ? 'replayed' : state === 'running' && now < deadline ? 'completed' : 'stale';
          assert.equal(journal.complete(current, 42).kind, expected);
          if (expected === 'completed') state = 'done';
          continue;
        }
        let expected: string;
        if (state === 'done') expected = 'replay';
        else if (state === 'unknown') expected = 'indeterminate';
        else if (state === 'running' && now < deadline) expected = 'busy';
        else if (state === 'running' && recovery === 'manual') { expected = 'indeterminate'; state = 'unknown'; }
        else { expected = 'acquired'; state = 'running'; deadline = now + 10; }
        const actual = journal.begin(intent, 10);
        assert.equal(actual.kind, expected);
        if (actual.kind === 'acquired') {
          if (current) old.push(current);
          current = actual.lease;
        }
      }
    }), { seed, numRuns: 1_000 });
});
