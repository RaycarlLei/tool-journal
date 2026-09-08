import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import fc from 'fast-check';
import { Journal, MemoryStore, SqliteStore, type Intent, type Lease, type Store } from '../src/index.js';

// The oracle uses public outcomes and numbered grants. It does not inspect rows,
// calculate fingerprints, or use the implementation's serialization helpers.
interface Account {
  phase: 'running' | 'uncertain' | 'finished';
  deadline: number;
  owner: number;
  grants: number[];
  receipt: number | undefined;
}
interface Model { now: number; nextGrant: number; accounts: Map<number, Account> }
interface Runtime {
  journals: Journal[];
  stores: Store[];
  leases: Map<number, Lease>;
  observed: Set<string>;
  reopen(client: number): void;
  close(): void;
}

const identities = [
  ['tenant', 'one'], ['tenant', 'two'], ['other', 'one'],
  ['tenant\u0000one', 'two'], ['tenant', 'one\u0000two'],
] as const;
function intent(slot: number, reverse = false): Intent {
  const [scope, key] = identities[slot]!;
  const request = { units: slot + 1, enabled: true };
  const input = reverse ? { request, tags: [slot, null] } : { tags: [slot, null], request };
  return { scope, key, tool: 'append', input, recovery: slot % 2 === 0 ? 'manual' : 'idempotent' };
}
function receipt(value: number, reverse = false) {
  const details = { labels: ['synthetic', value], verified: true };
  return reverse ? { details, receipt: value } : { receipt: value, details };
}

type Target = { slot: number; client: number };
type Action =
  | ({ op: 'begin'; duration: number; reverse: boolean } & Target)
  | { op: 'advance'; elapsed: number }
  | ({ op: 'complete'; holder: 'first' | 'current'; value: number; reverse: boolean } & Target)
  | ({ op: 'renew'; holder: 'first' | 'current'; duration: number } & Target)
  | ({ op: 'settle'; value: number; reverse: boolean } & Target)
  | ({ op: 'conflict'; field: 'input' | 'tool' | 'recovery' } & Target)
  | ({ op: 'abort' } & Target)
  | { op: 'reopen'; client: number };

class ContractCommand implements fc.Command<Model, Runtime> {
  constructor(readonly action: Action) {}

  check(model: Readonly<Model>): boolean {
    switch (this.action.op) {
      case 'complete': case 'renew': case 'conflict': case 'abort':
        return model.accounts.has(this.action.slot);
      default: return true;
    }
  }

  run(model: Model, real: Runtime): void {
    const action = this.action;
    real.observed.add(action.op);
    if (action.op === 'advance') {
      model.now += action.elapsed;
    } else if (action.op === 'reopen') {
      for (const account of model.accounts.values()) real.observed.add(`reopen:${account.phase}`);
      real.reopen(action.client);
    } else {
      const journal = real.journals[action.client]!;
      const account = model.accounts.get(action.slot);
      switch (action.op) {
        case 'begin': {
          const value = intent(action.slot, action.reverse);
          const actual = journal.begin(value, action.duration);
          real.observed.add(`begin:${actual.kind}`);
          if (account?.phase === 'finished') {
            assert.deepEqual(actual, { kind: 'replay', result: receipt(account.receipt!) });
          } else if (account?.phase === 'uncertain') {
            assert.deepEqual(actual, { kind: 'indeterminate' });
          } else if (account && model.now < account.deadline) {
            assert.deepEqual(actual, { kind: 'busy', leaseUntil: account.deadline });
          } else if (account && value.recovery === 'manual') {
            assert.deepEqual(actual, { kind: 'indeterminate' });
            account.phase = 'uncertain';
          } else {
            assert.equal(actual.kind, 'acquired');
            if (actual.kind !== 'acquired') throw new Error('Expected a new grant');
            assert.equal(actual.retry, account !== undefined);
            if (actual.retry) real.observed.add('begin:retry');
            assert.equal(actual.lease.epoch, (account?.grants.length ?? 0) + 1);
            for (const previous of real.leases.values()) {
              assert.notEqual(actual.lease.executor, previous.executor);
            }
            const grant = model.nextGrant++;
            real.leases.set(grant, actual.lease);
            model.accounts.set(action.slot, {
              phase: 'running', deadline: model.now + action.duration,
              owner: grant, grants: [...(account?.grants ?? []), grant], receipt: undefined,
            });
          }
          // Callers retain their input objects; later edits cannot rewrite history.
          if (value.input && typeof value.input === 'object' && !Array.isArray(value.input)) {
            value.input.request = { units: -1 };
          }
          break;
        }
        case 'complete': {
          const grant = action.holder === 'current' ? account!.owner : account!.grants[0]!;
          const owns = grant === account!.owner;
          const canCommit = owns && account!.phase === 'running' && model.now < account!.deadline;
          const expected = owns && account!.phase === 'finished'
            ? account!.receipt === action.value ? 'replayed' : 'conflict'
            : canCommit ? 'completed' : 'stale';
          const value = receipt(action.value, action.reverse);
          assert.equal(journal.complete(real.leases.get(grant)!, value).kind, expected);
          real.observed.add(`complete:${expected}`);
          if (!owns) real.observed.add('complete:retired');
          if (account!.phase === 'running' && model.now === account!.deadline) real.observed.add('complete:at-expiry');
          if (canCommit) { account!.phase = 'finished'; account!.receipt = action.value; }
          value.details.labels.push('caller mutation');
          break;
        }
        case 'renew': {
          const grant = action.holder === 'current' ? account!.owner : account!.grants[0]!;
          const allowed = grant === account!.owner && account!.phase === 'running' && model.now < account!.deadline;
          assert.equal(journal.renew(real.leases.get(grant)!, action.duration), allowed);
          real.observed.add(`renew:${allowed}`);
          if (allowed) real.observed.add(model.now + action.duration < account!.deadline ? 'renew:nonshortening' : 'renew:extended');
          if (account!.phase === 'running' && model.now === account!.deadline) real.observed.add('renew:at-expiry');
          if (allowed) account!.deadline = Math.max(account!.deadline, model.now + action.duration);
          break;
        }
        case 'settle': {
          const expected = account?.phase === 'finished'
            ? account.receipt === action.value ? 'replayed' : 'conflict'
            : account?.phase === 'uncertain' ? 'settled' : 'not_indeterminate';
          const value = receipt(action.value, action.reverse);
          assert.equal(journal.settle(intent(action.slot, action.reverse), value), expected);
          real.observed.add(`settle:${expected}`);
          if (account?.phase === 'running' && model.now >= account.deadline) real.observed.add('settle:expired-running');
          if (expected === 'settled') { account!.phase = 'finished'; account!.receipt = action.value; }
          value.details.labels.push('caller mutation');
          break;
        }
        case 'conflict': {
          const changed = intent(action.slot);
          if (action.field === 'input') changed.input = { units: -1 };
          if (action.field === 'tool') changed.tool = 'different-tool';
          if (action.field === 'recovery') changed.recovery = changed.recovery === 'manual' ? 'idempotent' : 'manual';
          assert.deepEqual(journal.begin(changed), { kind: 'conflict' });
          assert.equal(journal.settle(changed, receipt(0)), 'conflict');
          break;
        }
        case 'abort': {
          const lease = real.leases.get(account!.owner)!;
          const failure = new Error('injected transaction abort');
          assert.throws(() => real.stores[action.client]!.transact(lease.id, entry => {
            assert.ok(entry);
            entry.epoch += 1;
            throw failure;
          }), error => error === failure);
          break;
        }
      }
    }
    this.checkObservableAccounts(model, real);
  }

  private checkObservableAccounts(model: Model, real: Runtime): void {
    for (const [slot, account] of model.accounts) {
      // Observing an expired running action would itself recover it. Leave that
      // transition to an explicit begin command so shrinking preserves causality.
      if (account.phase === 'running' && model.now >= account.deadline) continue;
      for (const journal of real.journals) {
        const actual = journal.begin(intent(slot, true));
        if (account.phase === 'finished') {
          assert.deepEqual(actual, { kind: 'replay', result: receipt(account.receipt!) });
          if (actual.kind === 'replay' && actual.result && typeof actual.result === 'object' && !Array.isArray(actual.result)) {
            actual.result.receipt = -1;
          }
          assert.deepEqual(journal.begin(intent(slot)), { kind: 'replay', result: receipt(account.receipt!) });
        } else if (account.phase === 'uncertain') {
          assert.deepEqual(actual, { kind: 'indeterminate' });
        } else {
          assert.deepEqual(actual, { kind: 'busy', leaseUntil: account.deadline });
        }
      }
    }
  }

  toString(): string { return JSON.stringify(this.action); }
}

const slot = fc.integer({ min: 0, max: identities.length - 1 });
const client = fc.integer({ min: 0, max: 1 });
const duration = fc.integer({ min: 1, max: 12 });
const value = fc.integer({ min: 0, max: 3 });
const reverse = fc.boolean();
const holder = fc.constantFrom('first' as const, 'current' as const);
const commands = [
  fc.record({ op: fc.constant('begin' as const), slot, client, duration, reverse }),
  fc.record({ op: fc.constant('advance' as const), elapsed: fc.integer({ min: 0, max: 16 }) }),
  fc.record({ op: fc.constant('complete' as const), slot, client, holder, value, reverse }),
  fc.record({ op: fc.constant('renew' as const), slot, client, holder, duration }),
  fc.record({ op: fc.constant('settle' as const), slot, client, value, reverse }),
  fc.record({ op: fc.constant('conflict' as const), slot, client, field: fc.constantFrom('input' as const, 'tool' as const, 'recovery' as const) }),
  fc.record({ op: fc.constant('abort' as const), slot, client }),
  fc.record({ op: fc.constant('reopen' as const), client }),
].map(arbitrary => arbitrary.map(action => new ContractCommand(action)));

function runtime(adapter: 'memory' | 'sqlite', model: Model, observed: Set<string>): Runtime {
  const directory = adapter === 'sqlite' ? mkdtempSync(join(tmpdir(), 'journal-model-')) : undefined;
  const memory = new MemoryStore();
  const open = (): Store => directory ? new SqliteStore(join(directory, 'state.sqlite')) : memory;
  const stores = [open(), open()];
  const journals = stores.map(store => new Journal(store, () => model.now));
  return {
    journals, stores, leases: new Map(), observed,
    reopen(client) {
      const previous = stores[client]!;
      if (previous instanceof SqliteStore) previous.close();
      stores[client] = open();
      journals[client] = new Journal(stores[client]!, () => model.now);
    },
    close() {
      for (const store of stores) if (store instanceof SqliteStore) store.close();
      if (directory) {
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('journal-model-'));
        rmSync(target, { recursive: true, force: true });
      }
    },
  };
}

for (const adapter of ['memory', 'sqlite'] as const) {
  test(`${adapter}: shrinkable multi-action histories preserve the execution contract`, () => {
    const observed = new Set<string>();
    const boundary: Action[] = [
      { op: 'begin', slot: 0, client: 0, duration: 4, reverse: false },
      { op: 'begin', slot: 1, client: 1, duration: 4, reverse: false },
      { op: 'advance', elapsed: 1 },
      { op: 'renew', slot: 0, client: 1, holder: 'current', duration: 1 },
      { op: 'renew', slot: 1, client: 0, holder: 'current', duration: 6 },
      { op: 'advance', elapsed: 3 },
      { op: 'renew', slot: 0, client: 0, holder: 'current', duration: 5 },
      { op: 'complete', slot: 0, client: 1, holder: 'current', value: 1, reverse: false },
      { op: 'settle', slot: 0, client: 0, value: 1, reverse: false },
      { op: 'reopen', client: 0 },
      { op: 'begin', slot: 0, client: 1, duration: 4, reverse: true },
      { op: 'reopen', client: 1 },
      { op: 'settle', slot: 0, client: 1, value: 1, reverse: true },
      { op: 'complete', slot: 0, client: 0, holder: 'current', value: 1, reverse: false },
      { op: 'settle', slot: 0, client: 0, value: 2, reverse: false },
      { op: 'advance', elapsed: 3 },
      { op: 'renew', slot: 1, client: 1, holder: 'current', duration: 5 },
      { op: 'complete', slot: 1, client: 0, holder: 'current', value: 2, reverse: false },
      { op: 'begin', slot: 1, client: 0, duration: 4, reverse: true },
      { op: 'complete', slot: 1, client: 1, holder: 'first', value: 2, reverse: false },
      { op: 'renew', slot: 1, client: 1, holder: 'first', duration: 5 },
      { op: 'complete', slot: 1, client: 1, holder: 'current', value: 2, reverse: true },
      { op: 'reopen', client: 1 },
    ];
    const run = (history: Iterable<fc.Command<Model, Runtime>>) => {
      const model: Model = { now: 0, nextGrant: 0, accounts: new Map() };
      const real = runtime(adapter, model, observed);
      try { fc.modelRun(() => ({ model, real }), history); }
      finally { real.close(); }
    };
    // Cover exact deadlines explicitly; random histories explore interleavings.
    run(boundary.map(action => new ContractCommand(action)));
    fc.assert(fc.property(fc.commands(commands, { maxCommands: 100, size: 'max' }), history => {
      run(history);
    }), {
      seed: 20260908,
      numRuns: adapter === 'memory' ? 500 : 40,
      verbose: true,
    });
    // The boundary walk and seeded histories must reach the risky paths. These
    // are coverage checks, separate from the behavioral oracle above.
    for (const outcome of [
      'begin:acquired', 'begin:retry', 'begin:busy', 'begin:replay', 'begin:indeterminate',
      'complete:completed', 'complete:replayed', 'complete:conflict', 'complete:stale', 'complete:retired',
      'complete:at-expiry', 'renew:nonshortening', 'renew:extended', 'renew:at-expiry', 'settle:expired-running',
      'renew:true', 'renew:false', 'settle:settled', 'settle:replayed', 'settle:conflict', 'settle:not_indeterminate',
      'conflict', 'abort', 'reopen:running', 'reopen:uncertain', 'reopen:finished',
    ]) assert.ok(observed.has(outcome), `Histories did not exercise ${outcome}`);
  });
}
