import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export interface WorkerResult { kind: string; result?: unknown; phase?: string; lease?: { id: string; epoch: number; executor: string } }
export function runWorker(journal: string, ledger: string, strategy: string, phase = 'none', now = 100): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), journal, ledger, strategy, phase, String(now)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result: WorkerResult | undefined;
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker timed out')); }, 15_000);
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.on('message', message => {
      result = message as WorkerResult;
      if (result.kind === 'paused') child.kill('SIGKILL');
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (result && (code === 0 || result.kind === 'paused')) resolve(result);
      else reject(new Error(`Worker failed (${code}): ${stderr}`));
    });
  });
}
export function effectCount(path: string): number {
  const db = new DatabaseSync(path);
  try { return Number(db.prepare('SELECT count(*) AS n FROM effects').get()!.n); }
  finally { db.close(); }
}
