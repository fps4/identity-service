/**
 * The calls every kind's module is made of: a consistent get, a key or index query (paged to the end,
 * or counted), a single put/update/delete with a condition, a batch get, and the commit of a
 * transaction — each mapping DynamoDB's exceptions to `ConditionFailed` / `TransactionConflict` so the
 * kinds and the services never see an SDK error class.
 */
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  type DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import { fromItem } from './codec.js';
import type { Key } from './keys.js';
import { ConditionFailed, Transaction, TransactionConflict, updateExpression, type UpdateSpec, type WriteOptions } from './transaction.js';

export interface Db {
  readonly client: DynamoDBClient;
  readonly doc: DynamoDBDocumentClient;
  readonly table: string;
  readonly workspaceId: string;
}

type Item = Record<string, unknown>;

export interface QuerySpec {
  index?: 'gsi1' | 'gsi2' | 'pending';
  /** Key condition over `#pk` / `#sk` — the aliases are bound to the index's keys. */
  keyCondition: string;
  filter?: string;
  names?: Record<string, string>;
  values?: Record<string, unknown>;
  limit?: number;
  forward?: boolean;
  consistent?: boolean;
}

const INDEX_KEYS = {
  gsi1: { pk: 'gsi1pk', sk: 'gsi1sk' },
  gsi2: { pk: 'gsi2pk', sk: 'gsi2sk' },
  pending: { pk: 'pending_pk', sk: 'pending_sk' }
} as const;

function queryInput(db: Db, spec: QuerySpec): QueryCommandInput {
  const keys = spec.index ? INDEX_KEYS[spec.index] : { pk: 'pk', sk: 'sk' };
  // DynamoDB refuses a name an expression does not use: `#sk` is bound only where the condition has it.
  const usesSk = /#sk\b/.test(`${spec.keyCondition} ${spec.filter ?? ''}`);
  return {
    TableName: db.table,
    ...(spec.index ? { IndexName: spec.index } : {}),
    KeyConditionExpression: spec.keyCondition,
    ...(spec.filter ? { FilterExpression: spec.filter } : {}),
    ExpressionAttributeNames: { '#pk': keys.pk, ...(usesSk ? { '#sk': keys.sk } : {}), ...(spec.names ?? {}) },
    ...(spec.values ? { ExpressionAttributeValues: spec.values } : {}),
    ...(spec.limit !== undefined ? { Limit: spec.limit } : {}),
    ScanIndexForward: spec.forward ?? true,
    // Strongly consistent on the table; an index cannot be.
    ConsistentRead: spec.index ? false : spec.consistent ?? true
  };
}

/** How an item becomes a document: `fromItem` unless a kind keeps something under another name. */
export type Decode<T> = (item: Item) => T;

/** One item, read consistently. */
export async function getItem<T>(db: Db, key: Key, decode: Decode<T> = (item) => fromItem<T>(item) as T): Promise<T | null> {
  const out = await db.doc.send(new GetCommand({ TableName: db.table, Key: key, ConsistentRead: true }));
  return out.Item ? decode(out.Item as Item) : null;
}

/** The raw item, keys and all — for the outbox and for tests. */
export async function getRaw(db: Db, key: Key): Promise<Item | null> {
  const out = await db.doc.send(new GetCommand({ TableName: db.table, Key: key, ConsistentRead: true }));
  return (out.Item as Item | undefined) ?? null;
}

/** Every matching item, pages followed to the end (or to `limit`). */
export async function queryAll<T>(db: Db, spec: QuerySpec): Promise<T[]> {
  const out: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.doc.send(new QueryCommand({
      ...queryInput(db, spec),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      ...(spec.limit !== undefined ? { Limit: spec.limit - out.length } : {})
    }));
    for (const item of page.Items ?? []) out.push(fromItem<T>(item as Item) as T);
    startKey = page.LastEvaluatedKey;
    if (spec.limit !== undefined && out.length >= spec.limit) break;
  } while (startKey);
  return out;
}

/** The raw items of a query — for the relay, whose items carry the keys it acknowledges by. */
export async function queryRaw(db: Db, spec: QuerySpec): Promise<Item[]> {
  const out: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.doc.send(new QueryCommand({
      ...queryInput(db, spec),
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      ...(spec.limit !== undefined ? { Limit: spec.limit - out.length } : {})
    }));
    for (const item of page.Items ?? []) out.push(item as Item);
    startKey = page.LastEvaluatedKey;
    if (spec.limit !== undefined && out.length >= spec.limit) break;
  } while (startKey);
  return out;
}

/** How many items match, pages followed to the end. */
export async function count(db: Db, spec: QuerySpec): Promise<number> {
  let total = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.doc.send(new QueryCommand({
      ...queryInput(db, spec),
      Select: 'COUNT',
      ...(startKey ? { ExclusiveStartKey: startKey } : {})
    }));
    total += page.Count ?? 0;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}

/** Items by key, in batches of 100, in no particular order; absent keys are simply not returned. */
export async function batchGet<T>(db: Db, keys: Key[], decode: Decode<T> = (item) => fromItem<T>(item) as T): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending: Key[] = keys.slice(i, i + 100);
    while (pending.length) {
      const res = await db.doc.send(new BatchGetCommand({ RequestItems: { [db.table]: { Keys: pending, ConsistentRead: true } } }));
      for (const item of res.Responses?.[db.table] ?? []) out.push(decode(item as Item));
      pending = (res.UnprocessedKeys?.[db.table]?.Keys as Key[] | undefined) ?? [];
    }
  }
  return out;
}

/** Every item of the table, in pages — the backup's read. */
export async function* scanAll(db: Db, pageSize = 500): AsyncGenerator<Item[]> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await db.doc.send(new ScanCommand({
      TableName: db.table,
      Limit: pageSize,
      ConsistentRead: true,
      ...(startKey ? { ExclusiveStartKey: startKey } : {})
    }));
    yield (page.Items ?? []) as Item[];
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

export async function putItem(db: Db, item: Item, opts: WriteOptions = {}): Promise<void> {
  try {
    await db.doc.send(new PutCommand({
      TableName: db.table,
      Item: item,
      ...(opts.condition ? { ConditionExpression: opts.condition } : {}),
      ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
      ...(opts.values ? { ExpressionAttributeValues: opts.values } : {})
    }));
  } catch (err) {
    throw mapSingle(err, opts.label) ?? err;
  }
}

/** Update one item and return it as it is now, or `null` when the condition (by default: it exists) failed. */
export async function updateItem<T>(db: Db, key: Key, spec: UpdateSpec, opts: WriteOptions = {}): Promise<T | null> {
  const expr = updateExpression(spec, opts);
  const condition = opts.condition ?? 'attribute_exists(#pk)';
  try {
    const out = await db.doc.send(new UpdateCommand({
      TableName: db.table,
      Key: key,
      UpdateExpression: expr.UpdateExpression,
      ConditionExpression: condition,
      ExpressionAttributeNames: { ...expr.ExpressionAttributeNames, ...(/#pk\b/.test(condition) ? { '#pk': 'pk' } : {}) },
      ...(expr.ExpressionAttributeValues ? { ExpressionAttributeValues: expr.ExpressionAttributeValues } : {}),
      ReturnValues: 'ALL_NEW'
    }));
    return fromItem<T>(out.Attributes as Item | undefined);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
}

/** An update whose expression the caller wrote (e.g. `if_not_exists`); unconditional unless told otherwise. */
export async function updateRawItem<T>(db: Db, key: Key, expression: string, opts: WriteOptions = {}): Promise<T | null> {
  try {
    const out = await db.doc.send(new UpdateCommand({
      TableName: db.table,
      Key: key,
      UpdateExpression: expression,
      ...(opts.condition ? { ConditionExpression: opts.condition } : {}),
      ...(opts.names ? { ExpressionAttributeNames: opts.names } : {}),
      ...(opts.values ? { ExpressionAttributeValues: opts.values } : {}),
      ReturnValues: 'ALL_NEW'
    }));
    return fromItem<T>(out.Attributes as Item | undefined);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
}

/** Delete one item; true if it was there. */
export async function deleteItem(db: Db, key: Key): Promise<boolean> {
  const out = await db.doc.send(new DeleteCommand({ TableName: db.table, Key: key, ReturnValues: 'ALL_OLD' }));
  return Boolean(out.Attributes);
}

/**
 * Commit a transaction: nothing for an empty one, the single command for one write, `TransactWriteItems`
 * otherwise. A failed condition surfaces as `ConditionFailed` naming the write's label; a clash with a
 * concurrent transaction as `TransactionConflict`.
 */
export async function commit(db: Db, tx: Transaction): Promise<void> {
  if (tx.size === 0) return;
  if (tx.size === 1) {
    const [item] = tx.items;
    const label = tx.labels[0];
    try {
      if ('Put' in item) await db.doc.send(new PutCommand({ TableName: db.table, ...item.Put }));
      else if ('Update' in item) await db.doc.send(new UpdateCommand({ TableName: db.table, ...item.Update }));
      else if ('Delete' in item) await db.doc.send(new DeleteCommand({ TableName: db.table, ...item.Delete }));
      else {
        // A lone condition check is a read that must hold: run it as a transaction anyway.
        await db.doc.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: { TableName: db.table, ...item.ConditionCheck } }] }));
      }
    } catch (err) {
      throw mapSingle(err, label) ?? mapCancelled(err, tx.labels) ?? err;
    }
    return;
  }
  try {
    await db.doc.send(new TransactWriteCommand({
      TransactItems: tx.items.map((item) => {
        if ('Put' in item) return { Put: { TableName: db.table, ...item.Put } };
        if ('Update' in item) return { Update: { TableName: db.table, ...item.Update } };
        if ('Delete' in item) return { Delete: { TableName: db.table, ...item.Delete } };
        return { ConditionCheck: { TableName: db.table, ...item.ConditionCheck } };
      })
    }));
  } catch (err) {
    throw mapCancelled(err, tx.labels) ?? err;
  }
}


function mapSingle(err: unknown, label = 'write'): Error | null {
  if (err instanceof ConditionalCheckFailedException) return new ConditionFailed(label);
  if (err instanceof TransactionCanceledException) return null;
  return err as Error;
}

function mapCancelled(err: unknown, labels: string[]): Error | null {
  if (!(err instanceof TransactionCanceledException)) return null;
  const reasons = err.CancellationReasons ?? [];
  const failed = reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
  if (failed >= 0) return new ConditionFailed(labels[failed] ?? 'write');
  if (reasons.some((r) => r.Code === 'TransactionConflict')) return new TransactionConflict();
  return err;
}
