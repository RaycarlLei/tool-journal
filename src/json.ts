import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const MAX_JSON_BYTES = 1_048_576;

/** A deliberately small JSON domain: no coercion, accessors, cycles or sparse arrays. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let bytes = 0;
  function append(text: string): void {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_JSON_BYTES) throw new TypeError('JSON exceeds 1 MiB');
    chunks.push(text);
  }
  function string(text: string): void {
    // The encoded byte length cannot be smaller than the UTF-16 code-unit count.
    // Check before JSON.stringify allocates an escaped copy of a large string.
    if (text.length > MAX_JSON_BYTES - bytes) throw new TypeError('JSON exceeds 1 MiB');
    append(JSON.stringify(text));
  }
  function visit(v: unknown, depth: number): void {
    if (depth > 64) throw new TypeError('JSON exceeds depth 64');
    if (typeof v === 'string') { string(v); return; }
    if (v === null || typeof v === 'boolean') { append(JSON.stringify(v)); return; }
    if (typeof v === 'number' && Number.isFinite(v)) { append(JSON.stringify(v)); return; }
    if (typeof v !== 'object' || v === null) throw new TypeError('Expected finite JSON data');
    if (types.isProxy(v)) throw new TypeError('Proxy is not JSON data');
    if (ancestors.has(v)) throw new TypeError('Cyclic JSON');
    ancestors.add(v);
    try {
      const keys = Reflect.ownKeys(v);
      if (keys.some(k => typeof k === 'symbol')) throw new TypeError('Symbol key');
      if (keys.length > MAX_JSON_BYTES - bytes) throw new TypeError('JSON exceeds 1 MiB');
      if (Array.isArray(v)) {
        if (keys.length !== v.length + 1) throw new TypeError('Sparse or decorated array');
        append('[');
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d || !('value' in d)) throw new TypeError('Array accessor or hole');
          if (i) append(',');
          visit(d.value, depth + 1);
        }
        append(']');
        return;
      }
      const prototype: unknown = Object.getPrototypeOf(v);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected plain object');
      append('{');
      for (const [index, k] of (keys as string[]).sort().entries()) {
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!d.enumerable || !('value' in d)) throw new TypeError('Object accessor or hidden field');
        if (index) append(',');
        string(k);
        append(':');
        visit(d.value, depth + 1);
      }
      append('}');
    } finally { ancestors.delete(v); }
  }
  visit(value, 0);
  return chunks.join('');
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
