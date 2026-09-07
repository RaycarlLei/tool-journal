import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A deliberately small JSON domain: no coercion, accessors, cycles or sparse arrays. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): string {
    if (depth > 64) throw new TypeError('JSON exceeds depth 64');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null) throw new TypeError('Expected finite JSON data');
    if (ancestors.has(v)) throw new TypeError('Cyclic JSON');
    ancestors.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).some(k => typeof k === 'symbol')) throw new TypeError('Symbol key');
      if (Array.isArray(v)) {
        if (Object.keys(descriptors).length !== v.length + 1) throw new TypeError('Sparse or decorated array');
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          const d = descriptors[String(i)];
          if (!d || !('value' in d)) throw new TypeError('Array accessor or hole');
          parts.push(visit(d.value, depth + 1));
        }
        return '[' + parts.join(',') + ']';
      }
      const prototype: unknown = Object.getPrototypeOf(v);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected plain object');
      return '{' + Object.keys(descriptors).sort().map(k => {
        const d = descriptors[k]!;
        if (!d.enumerable || !('value' in d)) throw new TypeError('Object accessor or hidden field');
        return JSON.stringify(k) + ':' + visit(d.value, depth + 1);
      }).join(',') + '}';
    } finally { ancestors.delete(v); }
  }
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded) > 1_048_576) throw new TypeError('JSON exceeds 1 MiB');
  return encoded;
}

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
