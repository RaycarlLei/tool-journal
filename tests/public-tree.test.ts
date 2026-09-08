import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../../scripts/check-public.mjs', import.meta.url));

test('public candidates exclude nested installs but include tracked ignored files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-public-tree-'));
  function write(name: string, text: string): void {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: 'ignore' });
  }
  function check() {
    return spawnSync(process.execPath, [checker], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
  }
  try {
    git('init', '--quiet');
    write('.gitignore', 'node_modules/\nartifacts/\n.env*\n');
    write('integrations/example/demo.mjs', 'export const example = true;\n');
    write('integrations/example/node_modules/dependency/.env', 'synthetic ignored fixture');
    write('artifacts/report.json', '{}');
    const baseline = check();
    assert.equal(baseline.status, 0, baseline.stderr);

    // Force-staging a generated file cannot hide it behind .gitignore.
    git('add', '--force', 'integrations/example/node_modules/dependency/.env');
    const tracked = check();
    assert.equal(tracked.status, 1);
    assert.match(tracked.stderr, /generated file in public candidates/);
    assert.match(tracked.stderr, /private file type/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('public check rejects an untracked private candidate without printing its contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'journal-public-tree-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: directory, windowsHide: true, stdio: 'ignore' });
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', '.env.local'), 'SYNTHETIC_VALUE=do-not-print-this-fixture');
    const result = spawnSync(process.execPath, [checker], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private file type/);
    assert.doesNotMatch(result.stderr + result.stdout, /do-not-print-this-fixture/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
