import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export type Workload = 'execute' | 'replay';
export interface Failure { code: string; sqliteCode: number | null }
export interface Sample { sequence: number; elapsedMs: number; outcome: string; error: Failure | null }
export interface Cpu { user: number; system: number }
export const runtimeLimits = { workerMs: 90_000, fixtureMs: 240_000 } as const;

class RuntimeDeadlineError extends Error {
  readonly code: string;
  constructor(scope: 'worker' | 'fixture') {
    super(`Runtime ${scope} deadline exceeded`);
    this.code = scope === 'worker' ? 'ERR_RUNTIME_WORKER_DEADLINE' : 'ERR_RUNTIME_FIXTURE_DEADLINE';
  }
}

export type Configuration =
  | { kind: 'configure'; role: 'batch'; database: string; workload: Workload; worker: number; samples: number; warmup: number }
  | { kind: 'configure'; role: 'holder'; database: string; holdMs: number };
export type Reply =
  | { kind: 'ready' }
  | { kind: 'locked' }
  | { kind: 'released'; heldMs: number }
  | { kind: 'results'; worker: number; elapsedMs: number; cpu: Cpu; samples: Sample[] }
  | { kind: 'failed'; error: Failure };

export function failure(error: unknown): Failure {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  // Do not serialize arbitrary exception messages: they may contain local paths.
  return { code: typeof record.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(record.code) ? record.code : 'UNEXPECTED',
    sqliteCode: typeof record.errcode === 'number' ? record.errcode : null };
}
function isFailure(value: unknown): value is Failure {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(record.code) &&
    (record.sqliteCode === null || (Number.isSafeInteger(record.sqliteCode) && Number(record.sqliteCode) >= 0));
}
export const milliseconds = (value: number): number => Math.round(value * 1_000) / 1_000;
export function statistics(values: number[]) {
  if (values.length === 0) throw new Error('Cannot summarize an empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1)! };
}
export function fileBytes(database: string) {
  const size = (suffix: string): number => {
    try { return statSync(database + suffix).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  return { database: size(''), wal: size('-wal'), shm: size('-shm') };
}

/** A child is not released until its IPC handles have closed, including on failure. */
export class RuntimeChild {
  private readonly child: ChildProcess;
  private readonly queue: Reply[] = [];
  private readonly waiting = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;
  private ended = false;
  readonly closed: Promise<void>;

  constructor(arguments_: string[] = [fileURLToPath(new URL('./runtime-worker.js', import.meta.url))], timeoutMs: number = runtimeLimits.workerMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new TypeError('Invalid worker deadline');
    this.child = spawn(process.execPath, arguments_, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const deadline = setTimeout(() => this.fail(new RuntimeDeadlineError('worker')), timeoutMs);
    this.child.on('error', () => this.fail(new Error('Runtime worker could not start')));
    this.child.on('message', raw => {
      const value = raw as Reply;
      if (typeof value !== 'object' || value === null || Array.isArray(value) ||
          !['ready', 'locked', 'released', 'results', 'failed'].includes(value.kind)) {
        this.fail(new Error('Unexpected runtime worker message'));
      } else if (value.kind === 'failed') {
        // IPC payloads are runtime data. Never let a malformed failure throw
        // from the event listener and bypass child/fixture cleanup.
        this.fail(new Error(isFailure(value.error)
          ? `Runtime worker reported ${value.error.code}`
          : 'Unexpected runtime worker failure message'));
      } else {
        const waiter = this.waiting.get(value.kind);
        if (waiter) { this.waiting.delete(value.kind); waiter.resolve(value); }
        else if (this.queue.length < 8) this.queue.push(value);
        else this.fail(new Error('Too many runtime worker messages'));
      }
    });
    this.closed = new Promise(resolve => this.child.once('close', code => {
      clearTimeout(deadline);
      this.ended = true;
      if (code !== 0 && !this.failure) this.failure = new Error('Runtime worker exited unsuccessfully');
      for (const waiter of this.waiting.values()) waiter.reject(this.failure ?? new Error('Runtime worker exited before its reply'));
      this.waiting.clear();
      resolve();
    }));
  }
  private fail(error: Error): void {
    this.failure ??= error;
    if (!this.ended) this.child.kill('SIGKILL');
  }
  send(value: Configuration | { kind: 'start' | 'ack' }): void {
    if (this.failure || this.ended) throw this.failure ?? new Error('Runtime worker is closed');
    this.child.send(value, error => { if (error) this.fail(new Error('Runtime worker IPC failed')); });
  }
  receive<K extends Reply['kind']>(kind: K): Promise<Extract<Reply, { kind: K }>> {
    const queued = this.queue.findIndex(value => value.kind === kind);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0] as Extract<Reply, { kind: K }>);
    if (this.ended) return Promise.reject(this.failure ?? new Error('Runtime worker is closed'));
    if (this.waiting.has(kind)) throw new Error('Duplicate runtime worker waiter');
    const promise = new Promise<Reply>((resolve, reject) => this.waiting.set(kind, { resolve, reject }));
    // A synchronous SQLite call may postpone awaiting another already-armed reply.
    // Observe early rejection without changing the promise delivered to the caller.
    void promise.catch(() => {});
    return promise as Promise<Extract<Reply, { kind: K }>>;
  }
  async acknowledge(): Promise<void> {
    this.send({ kind: 'ack' });
    await this.closed;
    if (this.failure) throw this.failure;
  }
  async stop(error?: Error): Promise<void> {
    if (!this.ended) {
      if (error) this.fail(error);
      else this.child.kill('SIGKILL');
    }
    await this.closed;
  }
}

export class RuntimeFixture {
  private readonly root = realpathSync(tmpdir());
  readonly directory = realpathSync(mkdtempSync(join(this.root, 'journal-runtime-')));
  private readonly workers: RuntimeChild[] = [];
  private readonly deadline: NodeJS.Timeout;
  private readonly expiresAt = performance.now() + runtimeLimits.fixtureMs;
  private expired = false;
  constructor() {
    this.deadline = setTimeout(() => {
      this.expired = true;
      for (const worker of this.workers) void worker.stop(new RuntimeDeadlineError('fixture'));
    }, runtimeLimits.fixtureMs);
  }
  worker(arguments_?: string[], timeoutMs?: number): RuntimeChild {
    this.checkDeadline();
    const child = new RuntimeChild(arguments_, timeoutMs);
    this.workers.push(child);
    return child;
  }
  checkDeadline(): void {
    if (this.expired || performance.now() >= this.expiresAt) throw new RuntimeDeadlineError('fixture');
  }
  async close(): Promise<void> {
    clearTimeout(this.deadline);
    await Promise.all(this.workers.map(worker => worker.stop()));
    const resolved = realpathSync(this.directory);
    if (resolved !== this.directory || dirname(resolved) !== this.root || !basename(resolved).startsWith('journal-runtime-')) {
      throw new Error('Runtime fixture no longer resolves to its own temporary directory');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}
