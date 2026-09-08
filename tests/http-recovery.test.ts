import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, SqliteStore, type Intent } from '../src/index.js';
import { appendWithJournal, requestReceipt, ReceiptUnavailable, MAX_RESPONSE_BYTES } from '../examples/http/client.js';
import { startSyntheticService, MAX_REQUEST_BYTES, type SyntheticService } from '../examples/http/service.js';

const key = 'a'.repeat(64);
const operation = { scope: 'http-test', key: 'append-seven', tool: 'append', input: { units: 7 } };

for (const recovery of ['idempotent', 'manual'] as const) {
  test(`HTTP ${recovery}: lost receipt survives reopening both independent stores`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-http-test-'));
    const journalPath = join(dir, 'journal.sqlite'), downstreamPath = join(dir, 'downstream.sqlite');
    let service: SyntheticService | undefined;
    let store: SqliteStore | undefined;
    let now = 100;
    try {
      service = await startSyntheticService(downstreamPath);
      store = new SqliteStore(journalPath);
      let journal = new Journal(store, () => now);
      const action: Intent = { ...operation, ...(recovery === 'manual' ? { recovery } : { recovery, retryForMs: 60_000 }) };
      service.dropNextReply(recovery);
      assert.deepEqual(await appendWithJournal(journal, service.port, action, 10), { kind: 'unconfirmed', reason: 'transport' });
      const committed = service.snapshot();
      assert.equal(committed.calls, 1);
      assert.equal(committed.effects, 1, 'the effect must commit before the socket is destroyed');
      const receipt = { receipt: committed.receipts[0]!.receipt, units: 7 };
      assert.equal((await appendWithJournal(journal, service.port, action, 10)).kind, 'busy');
      assert.equal(service.snapshot().calls, 1);

      store.close();
      store = undefined;
      await service.close();
      service = undefined;
      service = await startSyntheticService(downstreamPath);
      store = new SqliteStore(journalPath);
      journal = new Journal(store, () => now);
      now = 111;
      const retried = await appendWithJournal(journal, service.port, action, 10);
      if (recovery === 'idempotent') assert.deepEqual(retried, { kind: 'completed', result: receipt });
      else assert.deepEqual(retried, { kind: 'indeterminate' });
      now = 200;
      const repeated = await appendWithJournal(journal, service.port, action, 10);
      if (recovery === 'idempotent') assert.deepEqual(repeated, { kind: 'replay', result: receipt });
      else assert.deepEqual(repeated, { kind: 'indeterminate' });
      assert.equal((await appendWithJournal(journal, service.port, { ...action, input: { units: 8 } }, 10)).kind, 'conflict');
      assert.equal(service.snapshot().calls, recovery === 'idempotent' ? 2 : 1);
      assert.deepEqual(service.snapshot().receipts, committed.receipts);
    } finally {
      store?.close();
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('HTTP service binds an idempotency key to its original payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-key-'));
  const service = await startSyntheticService(join(dir, 'downstream.sqlite'));
  try {
    const receipt = await requestReceipt(service.port, 'idempotent', 7, key);
    assert.deepEqual(await requestReceipt(service.port, 'idempotent', 7, key), receipt);
    await assert.rejects(requestReceipt(service.port, 'idempotent', 8, key), error => error instanceof ReceiptUnavailable && error.reason === 'http');
    assert.deepEqual(service.snapshot(), { calls: 3, effects: 1, receipts: [{ ...receipt, key }] });
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP service rejects malformed, oversized, and unsupported requests before an effect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-input-'));
  const service = await startSyntheticService(join(dir, 'downstream.sqlite'));
  try {
    for (const [path, body, contentType, status] of [
      ['/manual', '{', 'application/json', 400],
      ['/manual', '{"units":0}', 'application/json', 400],
      ['/manual', '{"units":7,"extra":true}', 'application/json', 400],
      ['/manual', 'x'.repeat(MAX_REQUEST_BYTES + 1), 'application/json', 413],
      ['/manual', '{"units":7}', 'text/plain', 415],
      ['/idempotent', '{"units":7}', 'application/json', 400],
      ['/unknown', '{"units":7}', 'application/json', 404],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
        method: 'POST', body, headers: { 'content-type': contentType }, signal: AbortSignal.timeout(2_000), redirect: 'error',
      });
      await response.arrayBuffer();
      assert.equal(response.status, status);
    }
    assert.deepEqual(service.snapshot(), { calls: 0, effects: 0, receipts: [] });
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('streamed requests without content-length cannot bypass the service body limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-stream-'));
  const service = await startSyntheticService(join(dir, 'downstream.sqlite'));
  try {
    const rejected = await new Promise<boolean>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: service.port, method: 'POST', path: '/manual', agent: false,
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
      const timer = setTimeout(() => { req.destroy(); reject(new Error('Stream limit test timed out')); }, 2_000);
      req.once('error', () => { clearTimeout(timer); resolve(true); });
      req.once('response', res => { clearTimeout(timer); res.resume(); resolve(res.statusCode === 413); });
      req.write(' '.repeat(MAX_REQUEST_BYTES));
      req.end('{"units":7}');
    });
    assert.equal(rejected, true);
    assert.deepEqual(service.snapshot(), { calls: 0, effects: 0, receipts: [] });
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('continuous body progress cannot refresh the absolute HTTP body deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-trickle-'));
  const bodyTimeoutMs = 400;
  const service = await startSyntheticService(join(dir, 'downstream.sqlite'), bodyTimeoutMs);
  const req = request({ host: '127.0.0.1', port: service.port, method: 'POST', path: '/manual', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': MAX_REQUEST_BYTES, expect: '100-continue' } });
  const closed = new Promise<void>(resolve => { req.once('close', resolve); });
  req.on('error', () => { /* Expiry must close the socket while its body is incomplete. */ });
  req.setTimeout(2_000, () => req.destroy());
  let trickle: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const accepted = once(req, 'continue');
    req.flushHeaders();
    await accepted;
    let chunksSent = 0;
    trickle = setInterval(() => {
      req.write(' ', error => { if (!error) chunksSent++; });
    }, 25);
    // Without the absolute deadline the trickle defeats the socket idle timer.
    // Bound this regression below that separate two-second idle deadline.
    const bounded = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Body deadline was refreshed by partial progress')), 1_500);
    });
    await Promise.race([closed, bounded]);
    assert.ok(chunksSent >= 3, 'the request must have made repeated progress before termination');
    assert.deepEqual(service.snapshot(), { calls: 0, effects: 0, receipts: [] });
  } finally {
    clearInterval(trickle);
    clearTimeout(watchdog);
    req.destroy();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service body deadlines reject invalid configuration before startup', async () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, 2_001]) {
    await assert.rejects(startSyntheticService(':memory:', invalid), /Body deadline/);
  }
});

test('service shutdown closes an unfinished HTTP request before its database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-close-'));
  const path = join(dir, 'downstream.sqlite');
  let service = await startSyntheticService(path);
  try {
    const req = request({ host: '127.0.0.1', port: service.port, method: 'POST', path: '/manual', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': 100, expect: '100-continue' } });
    const closed = new Promise<void>(resolve => { req.once('close', resolve); });
    req.on('error', () => { /* Shutdown deliberately aborts this partial request. */ });
    req.setTimeout(2_000, () => req.destroy());
    const accepted = once(req, 'continue');
    req.flushHeaders();
    await accepted;
    await service.close();
    await closed;
    await service.close(); // Closing is idempotent.
    service = await startSyntheticService(path);
    assert.deepEqual(service.snapshot(), { calls: 0, effects: 0, receipts: [] });
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function replyServer(t: TestContext, reply: (res: ServerResponse) => void): Promise<{ port: number; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => { calls++; req.resume(); reply(res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, calls: () => calls };
}

for (const [name, body] of [
  ['invalid JSON', '{'],
  ['wrong receipt schema', '{"receipt":0,"units":7}'],
  ['wrong input in receipt', '{"receipt":1,"units":8}'],
  ['oversized streamed receipt', 'x'.repeat(MAX_RESPONSE_BYTES + 1)],
] as const) {
  test(`HTTP client rejects ${name} without an automatic retry`, async t => {
    const service = await replyServer(t, res => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(body); // Force chunked encoding: the reader must enforce its own limit.
      res.end();
    });
    await assert.rejects(requestReceipt(service.port, 'manual', 7), error => error instanceof ReceiptUnavailable && error.reason === 'invalid-response');
    assert.equal(service.calls(), 1);
  });
}

test('HTTP client rejects redirects instead of following them', async t => {
  const service = await replyServer(t, res => { res.writeHead(302, { location: '/another-endpoint' }); res.end(); });
  await assert.rejects(requestReceipt(service.port, 'manual', 7), error => error instanceof ReceiptUnavailable && error.reason === 'http');
  assert.equal(service.calls(), 1);
});

test('HTTP client has a total request deadline and makes one attempt', async t => {
  const service = await replyServer(t, () => { /* Deliberately send no headers or body. */ });
  await assert.rejects(requestReceipt(service.port, 'manual', 7, undefined, 100), error => error instanceof ReceiptUnavailable && error.reason === 'transport');
  assert.equal(service.calls(), 1);
});

test('a receipt arriving after lease expiry is returned as stale, never completed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-http-expired-'));
  const store = new SqliteStore(join(dir, 'journal.sqlite'));
  let now = 100;
  const journal = new Journal(store, () => now);
  try {
    const service = await replyServer(t, res => {
      now = 111;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"receipt":1,"units":7}');
    });
    const action: Intent = { ...operation, recovery: 'manual' };
    assert.deepEqual(await appendWithJournal(journal, service.port, action, 10), { kind: 'stale', result: { receipt: 1, units: 7 } });
    assert.deepEqual(await appendWithJournal(journal, service.port, action, 10), { kind: 'indeterminate' });
    assert.equal(service.calls(), 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP helper rejects invalid local configuration before connecting', () => {
  assert.throws(() => requestReceipt(0, 'manual', 7), /port/);
  assert.throws(() => requestReceipt(80, 'manual', 7, key), /action key/);
  assert.throws(() => requestReceipt(80, 'idempotent', 7), /action key/);
  assert.throws(() => requestReceipt(80, 'manual', 1_001), /units/);
  assert.throws(() => requestReceipt(80, 'manual', 7, undefined, 0), /deadline/);
});
