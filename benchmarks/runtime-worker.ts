import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { Journal, SqliteStore, type Intent } from '../src/index.js';
import { failure, milliseconds, type Configuration, type Reply, type Sample } from './runtime-process.js';

function send(value: Reply): void {
  process.send!(value, error => { if (error) process.exitCode = 1; });
}
function command(kind: 'start' | 'ack'): Promise<void> {
  return new Promise((resolve, reject) => process.once('message', value => {
    if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind) resolve();
    else reject(new Error('Unexpected parent command'));
  }));
}
const value = (key: string): Intent => ({ scope: 'runtime-benchmark', key, tool: 'synthetic-append', input: { units: 7 }, recovery: 'idempotent', retryForMs: 120_000 });

async function run(config: Configuration): Promise<void> {
  if (!config || config.kind !== 'configure' || typeof config.database !== 'string') throw new Error('Invalid worker configuration');
  if (config.role === 'holder') {
    if (!Number.isSafeInteger(config.holdMs) || config.holdMs < 1 || config.holdMs > 6_000) throw new Error('Invalid hold duration');
    const db = new DatabaseSync(config.database, { timeout: 5_000 });
    try {
      const start = command('start');
      send({ kind: 'ready' });
      await start;
      db.exec('BEGIN IMMEDIATE');
      const began = performance.now();
      send({ kind: 'locked' });
      await new Promise(resolve => setTimeout(resolve, config.holdMs));
      db.exec('COMMIT');
      const ack = command('ack');
      send({ kind: 'released', heldMs: milliseconds(performance.now() - began) });
      await ack;
    } finally { db.close(); }
    return;
  }
  if (config.role !== 'batch' || !['execute', 'replay'].includes(config.workload) ||
      !Number.isSafeInteger(config.samples) || config.samples < 1 || config.samples > 5_000 ||
      !Number.isSafeInteger(config.warmup) || config.warmup < 0 || config.warmup > 500 ||
      !Number.isSafeInteger(config.worker) || config.worker < 0 || config.worker > 3) throw new Error('Invalid batch configuration');
  const store = new SqliteStore(config.database);
  try {
    const journal = new Journal(store);
    const operate = (key: string): string => {
      const begun = journal.begin(value(config.workload === 'replay' ? 'receipt' : key));
      if (config.workload === 'replay') {
        if (begun.kind !== 'replay') throw new Error('Expected completed receipt');
        return begun.kind;
      }
      if (begun.kind !== 'acquired' || begun.retry) throw new Error('Expected first acquisition');
      const complete = journal.complete(begun.lease, { receipt: 1 });
      if (complete.kind !== 'completed') throw new Error('Expected completion');
      return complete.kind;
    };
    for (let i = 0; i < config.warmup; i++) operate(`warm-${config.worker}-${i}`);
    const start = command('start');
    send({ kind: 'ready' });
    await start;
    const samples: Sample[] = [];
    const cpuStart = process.cpuUsage();
    const began = performance.now();
    for (let i = 0; i < config.samples; i++) {
      const started = performance.now();
      let outcome = 'error', error = null;
      try { outcome = operate(`sample-${config.worker}-${i}`); }
      catch (caught) { error = failure(caught); }
      samples.push({ sequence: i, elapsedMs: milliseconds(performance.now() - started), outcome, error });
    }
    const elapsedMs = milliseconds(performance.now() - began);
    const cpu = process.cpuUsage(cpuStart);
    const ack = command('ack');
    send({ kind: 'results', worker: config.worker, elapsedMs, cpu, samples });
    await ack;
  } finally { store.close(); }
}

if (!process.send || process.argv.length !== 2) {
  console.error('Runtime worker requires its benchmark parent');
  process.exitCode = 1;
} else {
  process.once('message', config => {
    void run(config as Configuration).then(() => process.disconnect()).catch(error => {
      process.exitCode = 1;
      process.send!({ kind: 'failed', error: failure(error) }, () => process.disconnect());
    });
  });
}
