import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';

const allowedRoots = new Set(['src', 'tests', 'scripts', 'examples', 'integrations', 'benchmarks', 'docs', '.github']);
const allowedFiles = new Set(['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes']);
const generated = new Set(['node_modules', '.git', 'dist', 'artifacts', 'coverage']);
const errors = [];
// Inspect publishable candidates, including already tracked files even when
// ignored. Nested integration dependencies are not source-tree candidates.
const candidates = new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean));
for (const name of candidates) {
  const parts = name.split('/');
  if (!(parts.length === 1 ? allowedFiles : allowedRoots).has(parts[0])) errors.push(`${name}: outside public allowlist`);
  if (parts.some(part => generated.has(part))) errors.push(`${name}: generated file in public candidates`);
  // Do not follow symlinked files or parent directories.
  let path = '.';
  let readable = true;
  for (const part of parts) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) { readable = false; break; }
    if (stat.isSymbolicLink()) { errors.push(`${name}: symlink`); readable = false; break; }
  }
  if (!readable) continue;
  const file = basename(name);
  if (/\.(?:sqlite|db|pem|key|p12|pfx|env|log)(?:$|\.)/i.test(file) || file.startsWith('.env')) errors.push(`${name}: private file type`);
  const text = readFileSync(path, 'utf8');
  if (/(?:[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\s"']+/i.test(text)) errors.push(`${name}: local home path`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{30,}/.test(text)) errors.push(`${name}: possible credential`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Public allowlist and credential/path checks passed. This is not a complete secret scanner.');
