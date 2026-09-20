/**
 * Documents in, items out, and back (ADR-0023 §1). An item is the document's own attributes plus the
 * key attributes the table needs (`pk`, `sk`, `kind`, the index keys, `expires_at`); reading strips them
 * again, so the services and the API see the document exactly as `models/` declares it.
 *
 * DynamoDB has no date type. A `Date` is written as its ISO string and revived on read by its name —
 * the camel-case `…At` fields and `lockedUntil` — except inside the opaque subtrees a caller owns
 * (`meta`, `context`, `claims`, `body`), whose strings are theirs. The spine envelope's `occurred_at` /
 * `recorded_at` / `delivered_at` are snake-case and stay strings, as the spine wants them.
 */
export const ITEM_ATTRIBUTES = ['pk', 'sk', 'kind', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'pending_pk', 'pending_sk', 'expires_at'] as const;

const DATE_FIELD = /At$|^lockedUntil$/;
const OPAQUE = new Set(['meta', 'context', 'claims', 'body']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Dates to ISO strings, `undefined` dropped, recursively — what the document client is given. */
export function toAttributes(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toAttributes);
  if (isPlain(value)) {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = toAttributes(v);
    }
    return out;
  }
  return value;
}

/** ISO strings back to Dates where the document declares a Date, recursively. */
export function reviveDates(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => reviveDates(v));
  if (isPlain(value)) {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value)) out[k] = OPAQUE.has(k) ? v : reviveDates(v, k);
    return out;
  }
  if (typeof value === 'string' && key !== undefined && DATE_FIELD.test(key) && ISO.test(value)) return new Date(value);
  return value;
}

/** The document an item holds: the table's attributes removed, dates revived. */
export function fromItem<T>(item: Plain | undefined): T | null {
  if (!item) return null;
  const doc: Plain = {};
  for (const [k, v] of Object.entries(item)) {
    if ((ITEM_ATTRIBUTES as readonly string[]).includes(k)) continue;
    doc[k] = v;
  }
  return reviveDates(doc) as T;
}

/** The epoch seconds a TTL attribute holds. */
export const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** A sequence number as a sort key that orders numerically: zero-padded to 12 digits. */
export const padSeq = (seq: number): string => String(seq).padStart(12, '0');
