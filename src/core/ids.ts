import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every depth and `undefined` dropped, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 of the canonical JSON of `value`. */
export function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** `<prefix>_` + the first 16 hex chars of the digest of `value`. */
export function shortId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 16)}`;
}
