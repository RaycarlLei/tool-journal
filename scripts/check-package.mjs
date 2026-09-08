import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check through npm run check:package');
const tempRoot = resolve(tmpdir());
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--candidate'),
  'Only --candidate is accepted');
const candidate = process.argv[2] === '--candidate';
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
}
function source() {
  assert.equal(git('status', '--porcelain'), '', 'Commit the source before creating a package candidate');
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(tree, /^[a-f0-9]{40}$/);
  return { commit, tree };
}
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
const candidateSource = candidate ? source() : undefined;
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

const directory = mkdtempSync(join(tempRoot, 'tool-journal-package-'));
try {
  const [archive] = JSON.parse(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], root));
  const names = archive.files.map(file => file.path);
  assert.ok(names.includes('dist/src/index.js'));
  assert.ok(names.includes('dist/src/index.d.ts'));
  for (const name of names) {
    assert.ok(/^(?:dist\/src\/[a-z-]+\.(?:js|d\.ts)|docs\/[a-z-]+\.md|package\.json|README\.md|LICENSE)$/.test(name),
      `Unexpected package member: ${name}`);
  }
  const sources = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n');
  const expected = new Set(['package.json', 'README.md', 'LICENSE']);
  for (const name of sources) {
    if (/^docs\/[a-z-]+\.md$/.test(name)) expected.add(name);
    if (/^src\/[a-z-]+\.ts$/.test(name)) {
      expected.add(`dist/${name.slice(0, -3)}.js`);
      expected.add(`dist/${name.slice(0, -3)}.d.ts`);
    }
  }
  assert.deepEqual([...names].sort(), [...expected].sort(), 'Package contains stale or missing source outputs');
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
  if (candidate) {
    assert.deepEqual(source(), candidateSource, 'Source changed during package verification');
    assert.equal(basename(archive.filename), archive.filename);
    const archivePath = join(directory, archive.filename);
    const archiveSha256 = sha256(archivePath);
    const provenance = {
      schemaVersion: 1,
      package: { name: manifest.name, version: manifest.version, file: archive.filename, sha256: archiveSha256 },
      source: { ...candidateSource, lockSha256: sha256(join(root, 'package-lock.json')) },
      build: { node: process.version, npm: run([npm, '--version']).trim(), platform: process.platform, arch: process.arch },
      verification: ['exact package members from source', 'offline install without hooks', 'SQLite reopen', 'public TypeScript consumer'],
      members: [...names].sort(),
    };
    // A new directory prevents stale or partly overwritten bundles from being
    // mistaken for this run. Copy the archive that the consumer actually tested.
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    assert.equal(dirname(realpathSync(artifacts)), realpathSync(root));
    assert.equal(basename(realpathSync(artifacts)), 'artifacts');
    const destination = mkdtempSync(join(artifacts, 'package-candidate-'));
    copyFileSync(archivePath, join(destination, archive.filename));
    assert.equal(sha256(join(destination, archive.filename)), archiveSha256);
    const provenancePath = join(destination, 'build-provenance.json');
    writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
    // Write the manifest last. A directory without it is an incomplete candidate.
    writeFileSync(join(destination, 'SHA256SUMS'),
      `${archiveSha256}  ${archive.filename}\n${sha256(provenancePath)}  build-provenance.json\n`, { flag: 'wx' });
    console.log(`Verified candidate: artifacts/${basename(destination)}`);
  }
  console.log(`Package ${manifest.name}@${manifest.version}: allowlist, offline install, SQLite reopen and public types passed.`);
} finally {
  assert.equal(dirname(resolve(directory)), tempRoot);
  assert.ok(basename(directory).startsWith('tool-journal-package-'));
  rmSync(directory, { recursive: true, force: true });
}
