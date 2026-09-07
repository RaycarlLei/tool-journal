import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const allowedRoots = new Set(['src', 'tests', 'scripts', 'examples', 'benchmarks', 'docs', '.github']);
const allowedFiles = new Set(['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes']);
const ignored = new Set(['node_modules', '.git', 'dist', 'artifacts']);
const errors = [];
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name), name = relative('.', path).replaceAll('\\', '/');
    if (dir === '.' && ignored.has(item.name)) continue;
    if (item.isSymbolicLink()) { errors.push(`${name}: symlink`); continue; }
    if (dir === '.' && !(item.isDirectory() ? allowedRoots : allowedFiles).has(item.name)) errors.push(`${name}: outside public allowlist`);
    if (item.isDirectory()) { walk(path); continue; }
    if (/\.(?:sqlite|db|pem|key|p12|pfx|env|log)(?:$|\.)/i.test(item.name)) errors.push(`${name}: private file type`);
    const text = readFileSync(path, 'utf8');
    if (/(?:[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\s"']+/i.test(text)) errors.push(`${name}: local home path`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{30,}/.test(text)) errors.push(`${name}: possible credential`);
  }
}
walk('.');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Public allowlist and credential/path checks passed. This is not a complete secret scanner.');
