import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, effectCount } from '../tests/fixtures/process.js';

const dir = mkdtempSync(join(tmpdir(), 'journal-demo-'));
try {
  for (const strategy of ['naive', 'checkpoint', 'journal-idempotent', 'journal-manual']) {
    const journal = join(dir, `${strategy}.sqlite`), ledger = join(dir, `${strategy}-ledger.sqlite`);
    await runWorker(journal, ledger, strategy, 'after-effect');
    const recovery = await runWorker(journal, ledger, strategy, 'none', 111);
    console.log(JSON.stringify({ strategy, crash: 'after-effect-before-receipt', recovery: recovery.kind, effects: effectCount(ledger) }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
