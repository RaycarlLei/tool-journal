import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, ledgerCounts, strategies } from '../tests/fixtures/process.js';

const dir = mkdtempSync(join(tmpdir(), 'journal-demo-'));
try {
  for (const strategy of strategies) {
    const journal = join(dir, `${strategy}.sqlite`), ledger = join(dir, `${strategy}-ledger.sqlite`);
    await runWorker(journal, ledger, strategy, 'after-effect');
    const recovery = await runWorker(journal, ledger, strategy, 'none', 111);
    const afterRecovery = ledgerCounts(ledger);
    const restarted = await runWorker(journal, ledger, strategy, 'none', 200);
    console.log(JSON.stringify({
      strategy, crash: 'after-effect-before-receipt', recovery: recovery.kind,
      ...afterRecovery, nextRestart: restarted.kind,
      additionalCallsOnRestart: ledgerCounts(ledger).calls - afterRecovery.calls,
    }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
