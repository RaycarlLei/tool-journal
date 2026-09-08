import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Deliberate faults in compiled output only. Each mutation must be killed independently.
// This is a targeted sensitivity check, not a whole-project mutation score.
const file = new URL('../dist/src/journal.js', import.meta.url);
const original = readFileSync(file, 'utf8');
const faults = [
  ['ignore changed input', 'entry.fingerprint !== fingerprint', 'false'],
  ['accept stale execution epochs', 'entry.epoch === lease.epoch && entry.executor === lease.executor', 'true'],
  ['retry an uncertain manual action', "entry.recovery === 'manual'", 'false'],
  ['allow completion after lease expiry', 'entry.leaseUntil <= this.now()', 'false'],
  ['resurrect an expired lease', "entry.state !== 'pending' || entry.leaseUntil <= now", "entry.state !== 'pending'"],
  ['shorten a renewed lease', 'Math.max(entry.leaseUntil, deadline)', 'deadline'],
  ['settle before uncertainty', "entry.state !== 'indeterminate'", 'false'],
];
const tests = ['--test', 'dist/tests/journal.test.js', 'dist/tests/model.test.js', 'dist/tests/integrity.test.js'];
const baseline = spawnSync(process.execPath, tests, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
if (baseline.status !== 0) throw new Error('Baseline tests must pass before mutation checks');
let failed = false;
try {
  for (const [name, needle, replacement] of faults) {
    if (!original.includes(needle)) throw new Error(`Mutation target moved: ${name}`);
    writeFileSync(file, original.replace(needle, replacement));
    const result = spawnSync(process.execPath, tests, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.error || result.signal) throw new Error(`Mutation test did not finish: ${name}`);
    const killed = result.status !== 0 && /AssertionError|ERR_ASSERTION/.test(result.stdout + result.stderr);
    console.log(`${killed ? 'killed' : 'SURVIVED'}: ${name}`);
    if (!killed) failed = true;
  }
} finally { writeFileSync(file, original); }
if (failed) process.exitCode = 1;
