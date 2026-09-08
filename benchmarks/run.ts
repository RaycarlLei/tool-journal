import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { runWorker, ledgerCounts, faultPhases, strategies } from '../tests/fixtures/process.js';

const rows: { repetition: number; strategy: string; phase: string; initialOutcome: string; outcome: string; calls: number; effects: number }[] = [];
for (let repetition = 0; repetition < 5; repetition++) {
  for (const strategy of strategies) for (const phase of faultPhases) {
    const dir = mkdtempSync(join(tmpdir(), 'journal-bench-'));
    try {
      const journal = join(dir, 'journal.sqlite'), ledger = join(dir, 'ledger.sqlite');
      const initial = await runWorker(journal, ledger, strategy, phase);
      assert.equal(initial.kind, phase === 'response-loss' ? 'response-lost' : 'paused');
      const result = await runWorker(journal, ledger, strategy, 'none', 111);
      rows.push({ repetition, strategy, phase, initialOutcome: initial.kind, outcome: result.kind, ...ledgerCounts(ledger) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
let commit = 'uncommitted';
let workingTreeDirty: boolean | null = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  workingTreeDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
} catch { /* An unpacked source archive has no Git metadata. */ }
const output = {
  protocol: 2, createdAt: new Date().toISOString(), commit, workingTreeDirty,
  environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release() },
  lockSha256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
  clock: 'Injected logical milliseconds; acquire=100, recover=111, lease=10. The three pause phases kill real processes; response-loss exits without delivering a committed receipt.',
  downstream: 'Both idempotent strategies use the identical stable action key and a durable deduplicating synthetic service. Calls count accepted requests, including deduplicated requests; effects count service commits.',
  repetitions: 5, scenarios: rows.length, rows,
};
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/crash-matrix.json', JSON.stringify(output, null, 2) + '\n');
console.table(strategies.map(strategy => {
  const selected = rows.filter(r => r.strategy === strategy);
  return { strategy, scenarios: selected.length, calls: selected.reduce((total, r) => total + r.calls, 0), effects: selected.reduce((total, r) => total + r.effects, 0), duplicates: selected.filter(r => r.effects > 1).length, indeterminate: selected.filter(r => r.outcome === 'indeterminate').length, confirmed: selected.filter(r => ['completed', 'replay'].includes(r.outcome)).length };
}));
console.log('Raw results: artifacts/crash-matrix.json');
