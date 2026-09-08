import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check through npm run check:package');
const tempRoot = resolve(tmpdir());
const directory = mkdtempSync(join(tempRoot, 'tool-journal-package-'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
  const value = manifest[field];
  assert.ok(value === undefined || (value !== null && typeof value === 'object' && Object.keys(value).length === 0),
    `Runtime dependency policy violated: ${field}`);
}
function run(args, cwd = directory) {
  return execFileSync(process.execPath, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  const [archive] = JSON.parse(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], root));
  const names = archive.files.map(file => file.path);
  assert.ok(names.includes('dist/src/index.js'));
  assert.ok(names.includes('dist/src/index.d.ts'));
  for (const name of names) {
    assert.ok(/^(?:dist\/src\/[a-z-]+\.(?:js|d\.ts)|docs\/[a-z-]+\.md|package\.json|README\.md|LICENSE)$/.test(name),
      `Unexpected package member: ${name}`);
  }
  // Install only the produced archive, without network access or lifecycle hooks.
  // Dependency policy is checked explicitly above; a warm cache is not evidence.
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, archive.filename)]);
  const installed = JSON.parse(readFileSync(join(directory, 'node_modules', manifest.name, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(installed.scripts?.[hook], undefined);
  writeFileSync(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { Journal, SqliteStore } from '@raycarllei/tool-journal';
const intent = { scope: 'package-check', key: 'once', tool: 'append', input: { units: 7 }, recovery: 'idempotent', retryForMs: 60000 };
let store = new SqliteStore('journal.sqlite');
const journal = new Journal(store, () => 100);
const begun = journal.begin(intent);
assert.equal(begun.kind, 'acquired');
assert.equal(journal.complete(begun.lease, { receipt: 7 }).kind, 'completed');
store.close();
store = new SqliteStore('journal.sqlite');
try { assert.deepEqual(new Journal(store).begin(intent), { kind: 'replay', result: { receipt: 7 } }); }
finally { store.close(); }
`);
  run(['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.mts'), `
import { Journal, MemoryStore, type Store, type Intent, type Begin } from '@raycarllei/tool-journal';
const memory = new MemoryStore();
const snapshot: ReturnType<MemoryStore['read']> = memory.read('missing');
const transactionOnly: Store = { transact: memory.transact.bind(memory) };
new Journal(transactionOnly);
void snapshot;
const intent: Intent = { scope: 'types', key: 'one', tool: 'append', input: null, recovery: 'manual' };
const journal = new Journal(new MemoryStore());
const result: Begin = journal.begin(intent);
if (result.kind === 'acquired') journal.complete(result.lease, { receipt: 1 });
const retryable: Intent = { ...intent, recovery: 'idempotent', retryForMs: 60000 };
const admitted = journal.begin(retryable);
if (admitted.kind === 'acquired') { const cutoff: number | null = admitted.retryStartBefore; void cutoff; }
// @ts-expect-error An idempotent operation requires a finite admission window.
const missingWindow: Intent = { scope: 'types', key: 'two', tool: 'append', input: null, recovery: 'idempotent' };
// @ts-expect-error A manual operation cannot acquire a retry policy accidentally.
const manualWindow: Intent = { scope: 'types', key: 'three', tool: 'append', input: null, recovery: 'manual', retryForMs: 60000 };
`);
  run([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--target', 'ES2023', 'consumer.mts']);
  console.log(`Package ${manifest.name}@${manifest.version}: allowlist, offline install, SQLite reopen and public types passed.`);
} finally {
  assert.equal(dirname(resolve(directory)), tempRoot);
  assert.ok(basename(directory).startsWith('tool-journal-package-'));
  rmSync(directory, { recursive: true, force: true });
}
