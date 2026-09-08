import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Journal, SqliteStore, type Intent } from '../src/index.js';
import { RuntimeFixture, failure, fileBytes, milliseconds, statistics, type Failure, type Workload } from './runtime-process.js';

const value = (key: string): Intent => ({ scope: 'runtime-benchmark', key, tool: 'synthetic-append', input: { units: 7 }, recovery: 'idempotent', retryForMs: 120_000 });
function seed(journal: Journal): void {
  const begun = journal.begin(value('receipt'));
  assert.equal(begun.kind, 'acquired');
  if (begun.kind !== 'acquired') throw new Error('Expected fresh fixture');
  assert.equal(journal.complete(begun.lease, { receipt: 1 }).kind, 'completed');
}

export async function runBatch(fixture: RuntimeFixture, workload: Workload, processes: 1 | 4, totalSamples: number, totalWarmup: number) {
  if (!Number.isSafeInteger(totalSamples) || totalSamples < processes || totalSamples % processes !== 0 ||
      !Number.isSafeInteger(totalWarmup) || totalWarmup < 0 || totalWarmup % processes !== 0) throw new TypeError('Invalid aggregate work');
  const name = `${workload}-${processes}-process`;
  const database = join(fixture.directory, `${name}.sqlite`);
  const anchor = new SqliteStore(database);
  try {
    if (workload === 'replay') seed(new Journal(anchor));
    const workers = Array.from({ length: processes }, () => fixture.worker());
    await Promise.all(workers.map((worker, index) => {
      const ready = worker.receive('ready');
      worker.send({ kind: 'configure', role: 'batch', database, workload, worker: index,
        samples: totalSamples / processes, warmup: totalWarmup / processes });
      return ready;
    }));
    const before = fileBytes(database);
    const pending = workers.map(worker => worker.receive('results'));
    const started = performance.now();
    for (const worker of workers) worker.send({ kind: 'start' });
    const results = await Promise.all(pending);
    const elapsedMs = milliseconds(performance.now() - started);
    const after = fileBytes(database);
    await Promise.all(workers.map(worker => worker.acknowledge()));
    anchor.close();
    const samples = results.flatMap(result => result.samples);
    assert.equal(samples.length, totalSamples);
    const errors = samples.filter(sample => sample.error !== null).length;
    return { name, workload, processes, totalSamples, totalWarmup, elapsedMs,
      latencyMs: statistics(samples.map(sample => sample.elapsedMs)), errors,
      operationsPerSecond: Math.round((samples.length - errors) * 1_000 / elapsedMs),
      cpu: results.reduce((total, result) => ({ user: total.user + result.cpu.user, system: total.system + result.cpu.system }), { user: 0, system: 0 }),
      storageBytes: { before, after, afterClose: fileBytes(database),
        measuredNetGrowth: { database: after.database - before.database, wal: after.wal - before.wal, shm: after.shm - before.shm } },
      workers: results };
  } finally { anchor.close(); }
}

export async function runHeldLock(fixture: RuntimeFixture, target: 'replay' | 'begin', holdMs: number) {
  const database = join(fixture.directory, `lock-${target}-${holdMs}.sqlite`);
  const store = new SqliteStore(database);
  try {
    const journal = new Journal(store);
    seed(journal);
    const holder = fixture.worker();
    const ready = holder.receive('ready');
    holder.send({ kind: 'configure', role: 'holder', database, holdMs });
    await ready;
    const before = fileBytes(database);
    const locked = holder.receive('locked');
    const released = holder.receive('released');
    holder.send({ kind: 'start' });
    await locked;
    const timerStarted = performance.now();
    const probe = new Promise<number>(resolve => setTimeout(() => resolve(milliseconds(performance.now() - timerStarted)), 0));
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    let outcome = 'error', error: Failure | null = null;
    try { outcome = journal.begin(value(target === 'replay' ? 'receipt' : 'new-key')).kind; }
    catch (caught) { error = failure(caught); }
    const elapsedMs = milliseconds(performance.now() - started);
    const cpu = process.cpuUsage(cpuStart);
    const timerDelayMs = await probe;
    const release = await released;
    await holder.acknowledge();
    // The result is observed, not prescribed: a completed-read fast path can
    // remove replay contention without changing the write-path measurement.
    assert.equal(journal.begin(value('receipt')).kind, 'replay');
    const after = fileBytes(database);
    store.close();
    return { target, requestedHoldMs: holdMs, actualHoldMs: release.heldMs, elapsedMs, timerDelayMs, cpu, outcome, error,
      storageBytes: { before, after, afterClose: fileBytes(database),
        measuredNetGrowth: { database: after.database - before.database, wal: after.wal - before.wal, shm: after.shm - before.shm } } };
  } finally { store.close(); }
}

function source(repository: string) {
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  let commit: string | null = null, workingTreeDirty: boolean | null = null;
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    commit = git('rev-parse', 'HEAD');
    workingTreeDirty = git('status', '--porcelain') !== '';
  } catch { /* Source archives may not have Git metadata. Build hashes remain available. */ }
  return { commit, workingTreeDirty, lockSha256: digest(join(repository, 'package-lock.json')),
    distSha256: Object.fromEntries(['src/index', 'src/journal', 'src/record', 'src/sqlite', 'src/memory', 'src/json',
      'benchmarks/runtime', 'benchmarks/runtime-process', 'benchmarks/runtime-worker'].map(name => [name, digest(join(repository, 'dist', `${name}.js`))])) };
}

class BenchmarkFailure extends Error {
  constructor(phase: string, readonly code: string, cause: unknown) {
    super(`Runtime benchmark failed during ${phase} (${code})`, { cause });
  }
}

export async function runtimeBenchmark(repository: string) {
  const initialSource = source(repository);
  const fixture = new RuntimeFixture();
  const started = performance.now();
  let phase = 'environment';
  try {
    const db = new DatabaseSync(':memory:');
    let sqliteVersion: unknown, pageBytes: unknown, walAutoCheckpointPages: unknown;
    try {
      sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get()!.version;
      pageBytes = db.prepare('PRAGMA page_size').get()!.page_size;
      walAutoCheckpointPages = db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint;
    }
    finally { db.close(); }
    const batches = [];
    for (const workload of ['execute', 'replay'] as const) for (const processes of [1, 4] as const) {
      phase = `${workload}-${processes}-process`;
      batches.push(await runBatch(fixture, workload, processes, workload === 'execute' ? 1_000 : 2_000, workload === 'execute' ? 100 : 200));
    }
    phase = 'idle-timers';
    const idleTimers = [];
    for (let i = 0; i < 20; i++) {
      const began = performance.now();
      await new Promise(resolve => setTimeout(resolve, 0));
      idleTimers.push(milliseconds(performance.now() - began));
    }
    const locked: Awaited<ReturnType<typeof runHeldLock>>[] = [];
    for (const target of ['replay', 'begin'] as const) for (const holdMs of [250, 6_000]) {
      phase = `held-lock-${target}-${holdMs}`;
      locked.push(await runHeldLock(fixture, target, holdMs));
    }
    phase = 'provenance';
    assert.deepEqual(source(repository), initialSource, 'Build or source metadata changed during measurement');
    fixture.checkDeadline();
    return { protocol: 'runtime-cost-1', createdAt: new Date().toISOString(), source: initialSource,
      environment: { node: process.version, sqlite: sqliteVersion, platform: process.platform, arch: process.arch,
        osRelease: release(), cpuModel: cpus()[0]?.model ?? 'unavailable', logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
      sqlite: { journalMode: 'WAL', synchronous: 'FULL', busyTimeoutMs: 5_000, pageBytes, walAutoCheckpointPages },
      timing: { clock: 'performance.now', unit: 'milliseconds', serializedResolution: 0.001,
        operation: 'Public API plus small intent construction and outcome checks; excludes process startup, setup, warmup and close.',
        batch: 'Parent start broadcast to all replies, including IPC; fixed aggregate work across process counts.',
        cpu: 'process.cpuUsage microseconds per measured batch/call, summed across execution processes.',
        quantiles: 'Nearest rank: ceil(p*n), no interpolation or removal of error samples.' },
      limits: { workerMs: 25_000, fixtureMs: 60_000 }, elapsedMs: milliseconds(performance.now() - started),
      batches, locks: { idleTimers, idleTimerMs: statistics(idleTimers), samples: locked,
        groups: ['replay', 'begin'].flatMap(target => [250, 6_000].map(holdMs => {
          const samples = locked.filter(sample => sample.target === target && sample.requestedHoldMs === holdMs);
          return { target, holdMs, latencyMs: statistics(samples.map(sample => sample.elapsedMs)),
            timerDelayMs: statistics(samples.map(sample => sample.timerDelayMs)), errors: samples.filter(sample => sample.error !== null).length };
        })) } };
  } catch (error) { throw new BenchmarkFailure(phase, failure(error).code, error); }
  finally { await fixture.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error('This benchmark accepts no arguments and creates only its own temporary databases.');
    process.exitCode = 1;
  } else {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    try {
      const result = await runtimeBenchmark(repository);
      mkdirSync(join(repository, 'artifacts'), { recursive: true });
      writeFileSync(join(repository, 'artifacts/runtime-cost.json'), JSON.stringify(result, null, 2) + '\n');
      console.table(result.batches.map(batch => ({ workload: batch.name, ...batch.latencyMs, errors: batch.errors })));
      console.table(result.locks.samples.map(sample => ({ target: sample.target, holdMs: sample.requestedHoldMs,
        elapsedMs: sample.elapsedMs, timerDelayMs: sample.timerDelayMs, outcome: sample.outcome, error: sample.error?.code ?? '' })));
      console.log('Raw samples and environment: artifacts/runtime-cost.json');
    } catch (error) {
      console.error(error instanceof BenchmarkFailure ? error.message : `Runtime benchmark failed (${failure(error).code})`);
      console.error('Child reclamation and fixture cleanup were attempted; no successful artifact was written.');
      process.exitCode = 1;
    }
  }
}
