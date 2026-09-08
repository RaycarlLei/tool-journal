import { request } from 'node:http';
import { Journal, type Begin, type Intent, type Recovery } from '../../src/index.js';

export type Receipt = { receipt: number; units: number };
export const MAX_RESPONSE_BYTES = 4_096;
const REQUEST_TIMEOUT_MS = 2_000;
type FailureReason = 'transport' | 'http' | 'invalid-response';

export class ReceiptUnavailable extends Error {
  constructor(readonly reason: FailureReason) {
    super(`Downstream receipt unavailable: ${reason}`);
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('Expected a loopback service port');
}

/** One request, fixed loopback address, no redirects or transport retries. */
export function requestReceipt(
  port: number, recovery: Recovery, units: number, key?: string, timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Receipt> {
  validatePort(port);
  if (!Number.isSafeInteger(units) || units < 1 || units > 1_000) throw new TypeError('Expected 1 to 1000 synthetic units');
  if (recovery !== 'idempotent' && recovery !== 'manual') throw new TypeError('Invalid recovery contract');
  if ((recovery === 'idempotent' && !/^[a-f0-9]{64}$/.test(key ?? '')) || (recovery === 'manual' && key !== undefined)) {
    throw new TypeError('Only the idempotent endpoint accepts a stable action key');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) throw new TypeError('Invalid request deadline');
  // The fixed schema also bounds the outbound body: at most 14 ASCII bytes.
  const body = JSON.stringify({ units });
  return new Promise<Receipt>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: `/${recovery}`, method: 'POST', agent: false,
      maxHeaderSize: 8_192,
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        ...(key ? { 'idempotency-key': key } : {}),
      },
    });
    let settled = false;
    const deadline = setTimeout(() => fail('transport'), timeoutMs);
    function fail(reason: FailureReason): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(new ReceiptUnavailable(reason));
    }
    req.once('error', () => fail('transport'));
    req.once('response', res => {
      res.once('error', () => fail('transport'));
      res.once('aborted', () => fail('transport'));
      if (res.statusCode !== 200) { fail('http'); return; }
      const length = Number(res.headers['content-length']);
      if (res.headers['content-type'] !== 'application/json' || (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)) {
        fail('invalid-response');
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { fail('invalid-response'); return; }
        chunks.push(chunk);
      });
      res.once('end', () => {
        if (settled) return;
        try {
          const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt) ||
              Object.keys(receipt).sort().join(',') !== 'receipt,units') throw new Error('Invalid receipt');
          const value = receipt as Receipt;
          if (!Number.isSafeInteger(value.receipt) || value.receipt < 1 || value.units !== units) throw new Error('Invalid receipt');
          settled = true;
          clearTimeout(deadline);
          resolve(value);
        } catch { fail('invalid-response'); }
      });
    });
    req.end(body);
  });
}

export type Dispatch = Exclude<Begin, { kind: 'acquired' }>
  | { kind: 'completed' | 'replayed' | 'stale'; result: Receipt }
  | { kind: 'unconfirmed'; reason: FailureReason };

/** A caller decides when to try again; this function never loops or settles uncertainty. */
export async function appendWithJournal(journal: Journal, port: number, intent: Intent, leaseMs = 5_000): Promise<Dispatch> {
  validatePort(port);
  const input = intent.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).join(',') !== 'units' ||
      typeof input.units !== 'number' || !Number.isSafeInteger(input.units) || input.units < 1 || input.units > 1_000) {
    throw new TypeError('Expected an input containing only 1 to 1000 synthetic units');
  }
  const begun = journal.begin(intent, leaseMs);
  if (begun.kind !== 'acquired') return begun;
  let receipt: Receipt;
  try {
    receipt = await requestReceipt(port, intent.recovery, input.units, intent.recovery === 'idempotent' ? begun.lease.id : undefined);
  } catch (error) {
    if (!(error instanceof ReceiptUnavailable)) throw error;
    // A timeout, invalid response, or non-success status is not evidence that
    // the downstream did nothing. Leave the durable pending record intact.
    return { kind: 'unconfirmed', reason: error.reason };
  }
  // Storage failures escape. Never claim a receipt was journaled if this fails.
  return { ...journal.complete(begun.lease, receipt), result: receipt };
}
