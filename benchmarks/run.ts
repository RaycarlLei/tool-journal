import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runWorker, effectCount } from '../tests/fixtures/process.js';

const rows: { repetition: number; strategy: string; phase: string; outcome: string; effects: number }[] = [];
const phases = ['before-effect', 'after-effect', 'after-complete'];
const strategies = ['naive', 'checkpoint', 'journal-idempotent', 'journal-manual'];
for (let repetition = 0; repetition < 5; repetition++) {
  for (const strategy of strategies) for (const phase of phases) {
    const dir = mkdtempSync(join(tmpdir(), 'journal-bench-'));
    try {
      const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
      await runWorker(journal, ledger, strategy, phase);
      const result = await runWorker(journal, ledger, strategy, 'none', 111);
      rows.push({ repetition, strategy, phase, outcome: result.kind, effects: effectCount(ledger) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
let commit = 'uncommitted';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* An unpacked source archive has no Git metadata. */ }
const output = {
  protocol: 1, createdAt: new Date().toISOString(), commit,
  environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release() },
  lockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
  clock: 'Injected logical milliseconds; acquire=100, recover=111, lease=10. Processes are really killed.',
  repetitions: 5, scenarios: rows.length, rows,
};
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/crash-matrix.json', JSON.stringify(output, null, 2) + '\n');
console.table(strategies.map(strategy => {
  const selected = rows.filter(r => r.strategy === strategy);
  return { strategy, scenarios: selected.length, duplicates: selected.filter(r => r.effects > 1).length, indeterminate: selected.filter(r => r.outcome === 'indeterminate').length, confirmed: selected.filter(r => ['completed', 'replay'].includes(r.outcome)).length };
}));
console.log('Raw results: artifacts/crash-matrix.json');
