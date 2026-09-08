import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import type { Recovery } from '../../src/index.js';
import type { Receipt } from './client.js';

export const MAX_REQUEST_BYTES = 1_024;
class HttpError extends Error {
  constructor(readonly status: number) { super(`Synthetic service rejected request (${status})`); }
}

async function readUnits(req: IncomingMessage, bodyTimeoutMs: number): Promise<number> {
  if (req.headers['content-type'] !== 'application/json') throw new HttpError(415);
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const expiresAt = performance.now() + bodyTimeoutMs;
  // This deadline is never refreshed by body progress. The monotonic check
  // also rejects a late body if event-loop delay postpones the timer callback.
  const deadline = setTimeout(() => req.destroy(), bodyTimeoutMs);
  function checkDeadline(): void {
    if (performance.now() >= expiresAt) {
      req.destroy();
      throw new HttpError(408);
    }
  }
  try {
    for await (const chunk of req) {
      checkDeadline();
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413);
      chunks.push(buffer);
    }
    checkDeadline();
  } finally {
    clearTimeout(deadline);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).join(',') !== 'units') throw new HttpError(400);
  const units = (value as { units: unknown }).units;
  if (typeof units !== 'number' || !Number.isSafeInteger(units) || units < 1 || units > 1_000) throw new HttpError(400);
  return units;
}

export interface SyntheticService {
  readonly port: number;
  dropNextReply(recovery: Recovery): void;
  snapshot(): { calls: number; effects: number; receipts: (Receipt & { key: string | null })[] };
  close(): Promise<void>;
}

/** Test ledger only: binds IPv4 loopback and never contacts another service. */
export async function startSyntheticService(path: string, bodyTimeoutMs = 2_000): Promise<SyntheticService> {
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 2_000) {
    throw new TypeError('Body deadline must be an integer from 1 to 2000 milliseconds');
  }
  const db = new DatabaseSync(path, { timeout: 2_000 });
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS effects (receipt INTEGER PRIMARY KEY, key TEXT UNIQUE, units INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS requests (attempt INTEGER PRIMARY KEY, key TEXT) STRICT;
    `);
  } catch (error) { db.close(); throw error; }

  const droppedReplies = new Set<Recovery>();
  const pending = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 8_192, headersTimeout: 1_000, requestTimeout: 2_000 }, (req, res) => {
    const task = handle(req, res);
    pending.add(task);
    void task.then(() => pending.delete(task), () => { pending.delete(task); res.destroy(); });
  });
  server.maxHeadersCount = 32;
  server.setTimeout(2_000, socket => socket.destroy());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST' || (req.url !== '/idempotent' && req.url !== '/manual')) throw new HttpError(404);
      const recovery: Recovery = req.url === '/idempotent' ? 'idempotent' : 'manual';
      const header = req.headers['idempotency-key'];
      if ((recovery === 'idempotent' && (typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header))) ||
          (recovery === 'manual' && header !== undefined)) throw new HttpError(400);
      const units = await readUnits(req, bodyTimeoutMs);
      if (!req.complete || res.destroyed) return;
      const key = typeof header === 'string' ? header : null;
      let receipt: Receipt;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO requests(key) VALUES (?)').run(key);
        const prior = key === null ? undefined : db.prepare('SELECT receipt, units FROM effects WHERE key = ?').get(key);
        if (prior && prior.units !== units) {
          db.exec('COMMIT');
          throw new HttpError(409);
        }
        if (!prior) db.prepare('INSERT INTO effects(key, units) VALUES (?, ?)').run(key, units);
        const id = prior ? Number(prior.receipt) : Number(db.prepare('SELECT last_insert_rowid() AS id').get()!.id);
        receipt = { receipt: id, units };
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }

      if (droppedReplies.delete(recovery)) {
        // This is the only fault injection: the independent service committed,
        // then the real TCP connection closes before HTTP response headers.
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(receipt));
    } catch (error) {
      if (!res.destroyed) {
        res.writeHead(error instanceof HttpError ? error.status : 500, { connection: 'close' });
        res.end();
      }
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { db.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    dropNextReply(recovery) { droppedReplies.add(recovery); },
    snapshot() {
      const receipts = db.prepare('SELECT receipt, key, units FROM effects ORDER BY receipt').all()
        .map(row => ({ receipt: Number(row.receipt), key: row.key === null ? null : String(row.key), units: Number(row.units) }));
      return { calls: Number(db.prepare('SELECT count(*) AS n FROM requests').get()!.n), effects: receipts.length, receipts };
    },
    close() {
      return closing ??= (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        } finally {
          await Promise.allSettled(pending);
          db.close();
        }
      })();
    },
  };
}
