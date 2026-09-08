import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const example = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(example, '../..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this installer through npm run prepare (or npm ci)');
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const lock = readFileSync(join(example, 'package-lock.json'));
const archiveDir = mkdtempSync(join(tmpdir(), 'journal-langgraph-package-'));
try {
  process.stdout.write(npm(['run', 'build'], root));
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', archiveDir], root));
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string' || filename !== basename(filename) || !filename.endsWith('.tgz')) throw new Error('Unexpected npm archive filename');
  // --no-save keeps the framework lock independent of a root archive whose
  // contents change as this repository evolves. npm still reads that lock.
  process.stdout.write(npm(['install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', join(archiveDir, filename)], example));
  if (!readFileSync(join(example, 'package-lock.json')).equals(lock)) throw new Error('Installing the root archive unexpectedly changed the framework lock');
} finally {
  if (dirname(resolve(archiveDir)) !== resolve(tmpdir()) || !basename(archiveDir).startsWith('journal-langgraph-package-')) {
    throw new Error('Refusing to clean an unexpected archive directory');
  }
  rmSync(archiveDir, { recursive: true, force: true });
}
