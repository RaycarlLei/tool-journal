import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, SqliteStore, type Intent } from '../src/index.js';
import { appendWithJournal } from './http/client.js';
import { startSyntheticService } from './http/service.js';

// No credentials, arbitrary URLs, or real-world side effects. The two SQLite
// files are independent, and the receipt really crosses a loopback HTTP socket.
const dir = mkdtempSync(join(tmpdir(), 'journal-http-demo-'));
try {
  for (const recovery of ['idempotent', 'manual'] as const) {
    const service = await startSyntheticService(join(dir, `${recovery}-downstream.sqlite`));
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(join(dir, `${recovery}-journal.sqlite`));
      let now = 100;
      const journal = new Journal(store, () => now);
      const intent: Intent = { scope: 'http-demo', key: 'append-seven', tool: 'append', input: { units: 7 },
        ...(recovery === 'manual' ? { recovery } : { recovery, retryForMs: 60_000 }) };
      service.dropNextReply(recovery);
      const first = await appendWithJournal(journal, service.port, intent, 10);
      assert.equal(first.kind, 'unconfirmed');
      const committed = service.snapshot();
      assert.equal(committed.effects, 1);
      now = 111; // Logical clock: expire the 10 ms lease without a timing race.
      const retried = await appendWithJournal(journal, service.port, intent, 10);
      const repeated = await appendWithJournal(journal, service.port, intent, 10);
      const final = service.snapshot();
      assert.equal(retried.kind, recovery === 'idempotent' ? 'completed' : 'indeterminate');
      assert.equal(repeated.kind, recovery === 'idempotent' ? 'replay' : 'indeterminate');
      assert.equal(final.effects, 1);
      assert.equal(final.calls, recovery === 'idempotent' ? 2 : 1);
      console.log(JSON.stringify({ recovery, first: first.kind, retry: retried.kind, repeat: repeated.kind, calls: final.calls, effects: final.effects }));
    } finally {
      store?.close();
      await service.close();
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
