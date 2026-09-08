import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const strategies = ['naive', 'checkpoint', 'downstream-idempotency-only', 'journal-idempotent', 'journal-manual'] as const;
export const faultPhases = ['before-effect', 'after-effect', 'after-complete', 'response-loss'] as const;
export type Strategy = typeof strategies[number];
export type FaultPhase = typeof faultPhases[number];
export interface WorkerResult { kind: string; result?: unknown; phase?: string; lease?: { id: string; epoch: number; executor: string } }
export interface LedgerCounts { calls: number; effects: number }

function launchWorker(
  journal: string, ledger: string, strategy: Strategy | 'claim', phase: FaultPhase | 'none', now: number,
  whilePaused?: () => Promise<void>, resumeAt = now,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), journal, ledger, strategy, phase, String(now)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result: WorkerResult | undefined;
    let failure: Error | undefined;
    let sawPause = false;
    let stderr = '';
    const timer = setTimeout(() => {
      failure = new Error(`Worker timed out: ${strategy}/${phase}`);
      child.kill('SIGKILL');
    }, 15_000);
    child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    child.once('error', error => { failure = error; });
    child.on('message', message => {
      result = message as WorkerResult;
      if (result.kind !== 'paused') return;
      if (sawPause) {
        failure = new Error('Worker paused more than once');
        child.kill('SIGKILL');
        return;
      }
      sawPause = true;
      if (!whilePaused) {
        child.kill('SIGKILL');
        return;
      }
      void whilePaused().then(() => {
        if (!failure && child.connected) child.send({ kind: 'resume', now: resumeAt }, error => {
          if (error) { failure = error; child.kill('SIGKILL'); }
        });
      }).catch(error => {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGKILL');
      });
    });
    // Wait for close, including inherited handles, before a caller removes its
    // temporary database. In particular a timed-out child must first terminate.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (result && code === 0 && (!whilePaused || sawPause)) resolve(result);
      else if (result?.kind === 'paused' && !whilePaused && (signal === 'SIGKILL' || code !== 0)) resolve(result);
      else reject(new Error(`Worker failed (${code}, ${signal}): ${stderr}`));
    });
  });
}

export function runWorker(journal: string, ledger: string, strategy: Strategy | 'claim', phase: FaultPhase | 'none' = 'none', now = 100): Promise<WorkerResult> {
  return launchWorker(journal, ledger, strategy, phase, now);
}

/** Keep an old executor alive while the callback runs competing processes. */
export function resumeWorkerAfter(
  journal: string, ledger: string, strategy: Strategy, phase: Exclude<FaultPhase, 'response-loss'>,
  whilePaused: () => Promise<void>, resumeAt: number,
): Promise<WorkerResult> {
  return launchWorker(journal, ledger, strategy, phase, 100, whilePaused, resumeAt);
}

export function ledgerCounts(path: string): LedgerCounts {
  const db = new DatabaseSync(path);
  try {
    return {
      calls: Number(db.prepare('SELECT count(*) AS n FROM calls').get()!.n),
      effects: Number(db.prepare('SELECT count(*) AS n FROM effects').get()!.n),
    };
  } finally { db.close(); }
}

export function effectCount(path: string): number { return ledgerCounts(path).effects; }
