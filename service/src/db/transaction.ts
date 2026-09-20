/**
 * A transaction (ADR-0023 §3): the writes of one act, committed as one `TransactWriteItems`. A service
 * reads what it needs, builds the writes with conditions that say what it read is still true, and
 * commits; the recorder adds the outbox items and the counters to the same transaction, so an act and
 * its record land together or not at all. DynamoDB transactions always exist — there is no
 * standalone-server fallback (maestro ADR-0018).
 *
 * A write may carry a `label`. When the transaction is cancelled on a failed condition, the error names
 * the label of the write that failed, so a caller can tell "this email is taken" (its own condition)
 * from "the counter moved" (the record's, retried by `withRecordTransaction`).
 */
import type { Key } from './keys.js';

export interface WriteOptions {
  condition?: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
  /** Names the write in a `ConditionFailed`. */
  label?: string;
}

export interface UpdateSpec {
  set?: Record<string, unknown>;
  remove?: string[];
}

/** A condition on one item did not hold; `label` says which write. */
export class ConditionFailed extends Error {
  constructor(public readonly label: string) {
    super(`condition failed: ${label}`);
    this.name = 'ConditionFailed';
  }
}

/** Another transaction touched an item of this one; retry from the reads. */
export class TransactionConflict extends Error {
  constructor() {
    super('transaction conflict');
    this.name = 'TransactionConflict';
  }
}

/** The one-item shapes `TransactWriteItems` takes, with our label beside each. */
export type TransactItem =
  | { Put: { Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { Update: { Key: Key; UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { Delete: { Key: Key; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } }
  | { ConditionCheck: { Key: Key; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } };

/** DynamoDB's ceiling on items per transaction. */
export const TRANSACTION_LIMIT = 100;

/**
 * An update expression from a spec: `SET` for every key of `set` (a `Date` becomes its ISO string),
 * `REMOVE` for `remove`. Attribute names are always aliased, so reserved words (`status`, `type`,
 * `scope`, `value`) need no care at the call site.
 */
export function updateExpression(spec: UpdateSpec, opts: WriteOptions = {}): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  const names: Record<string, string> = { ...(opts.names ?? {}) };
  const values: Record<string, unknown> = { ...(opts.values ?? {}) };
  const sets: string[] = [];
  const removes: string[] = [];
  let i = 0;
  for (const [field, value] of Object.entries(spec.set ?? {})) {
    if (value === undefined) { removes.push(alias(field)); continue; }
    const v = `:u${i++}`;
    sets.push(`${alias(field)} = ${v}`);
    values[v] = value instanceof Date ? value.toISOString() : value;
  }
  for (const field of spec.remove ?? []) removes.push(alias(field));
  const parts: string[] = [];
  if (sets.length) parts.push(`SET ${sets.join(', ')}`);
  if (removes.length) parts.push(`REMOVE ${removes.join(', ')}`);
  if (parts.length === 0) throw new Error('an update needs something to set or remove');
  return {
    UpdateExpression: parts.join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
  };

  function alias(field: string): string {
    const name = `#${field.replace(/[^A-Za-z0-9_]/g, '_')}`;
    names[name] = field;
    return name;
  }
}

/**
 * An upsert's expression: `set` is written every time (`undefined` removes), `setOnInsert` only where
 * the attribute is absent (`if_not_exists`) — the seed's reconcile rule (ADR-0021), and `createdAt`'s.
 * Both are given as attributes (dates already ISO strings).
 */
export function upsertExpression(set: Record<string, unknown>, setOnInsert: Record<string, unknown> = {}): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  let i = 0;
  for (const [field, value] of Object.entries(set)) {
    const n = `#f${i}`;
    names[n] = field;
    if (value === undefined) { removes.push(n); i++; continue; }
    values[`:f${i}`] = value;
    sets.push(`${n} = :f${i}`);
    i++;
  }
  for (const [field, value] of Object.entries(setOnInsert)) {
    if (value === undefined) continue;
    const n = `#f${i}`;
    names[n] = field;
    values[`:f${i}`] = value;
    sets.push(`${n} = if_not_exists(${n}, :f${i})`);
    i++;
  }
  return {
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  };
}

/** A raw `SET` clause the caller wrote (e.g. `if_not_exists`), merged with a spec's. */
export function rawUpdate(expression: string, opts: WriteOptions = {}): {
  UpdateExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  return {
    UpdateExpression: expression,
    ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
    ...(opts.values ? { ExpressionAttributeValues: opts.values } : {})
  };
}

export class Transaction {
  readonly items: TransactItem[] = [];
  readonly labels: string[] = [];
  /** Every item this transaction puts, by key — what a read inside the act may consult before the commit. */
  readonly staged = new Map<string, Record<string, unknown>>();

  get size(): number {
    return this.items.length;
  }

  put(item: Record<string, unknown>, opts: WriteOptions = {}): this {
    this.add({ Put: { Item: item, ...conditionOf(opts) } }, opts.label);
    this.staged.set(`${String(item.pk)}|${String(item.sk)}`, item);
    return this;
  }

  update(key: Key, spec: UpdateSpec, opts: WriteOptions = {}): this {
    const expr = updateExpression(spec, opts);
    this.add({
      Update: {
        Key: key,
        UpdateExpression: expr.UpdateExpression,
        ...(opts.condition ? { ConditionExpression: opts.condition } : {}),
        ExpressionAttributeNames: expr.ExpressionAttributeNames,
        ...(expr.ExpressionAttributeValues ? { ExpressionAttributeValues: expr.ExpressionAttributeValues } : {})
      }
    }, opts.label);
    return this;
  }

  /** An update whose expression the caller wrote in full. */
  updateRaw(key: Key, expression: string, opts: WriteOptions = {}): this {
    this.add({
      Update: {
        Key: key,
        ...rawUpdate(expression, opts),
        ...(opts.condition ? { ConditionExpression: opts.condition } : {})
      }
    }, opts.label);
    return this;
  }

  delete(key: Key, opts: WriteOptions = {}): this {
    this.add({ Delete: { Key: key, ...conditionOf(opts) } }, opts.label);
    return this;
  }

  check(key: Key, opts: WriteOptions & { condition: string }): this {
    this.add({ ConditionCheck: { Key: key, ConditionExpression: opts.condition, ...namesAndValues(opts) } }, opts.label);
    return this;
  }

  private add(item: TransactItem, label = 'write'): void {
    if (this.items.length >= TRANSACTION_LIMIT) {
      throw new Error(`a transaction holds at most ${TRANSACTION_LIMIT} writes; split the act`);
    }
    this.items.push(item);
    this.labels.push(label);
  }
}

function conditionOf(opts: WriteOptions) {
  return {
    ...(opts.condition ? { ConditionExpression: opts.condition } : {}),
    ...namesAndValues(opts)
  };
}

function namesAndValues(opts: WriteOptions) {
  return {
    ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
    ...(opts.values ? { ExpressionAttributeValues: opts.values } : {})
  };
}

/** The label prefix of the record's own writes — the ones a retry, not the caller, answers for. */
export const RECORD_LABEL = 'record:';

/** True if a failed condition is the record's (a counter moved, a sequence was taken): retry from the reads. */
export const isRecordConflict = (err: unknown): boolean =>
  err instanceof TransactionConflict || (err instanceof ConditionFailed && err.label.startsWith(RECORD_LABEL));
