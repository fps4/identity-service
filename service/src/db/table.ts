/**
 * The table (ADR-0023, maestro ADR-0018): one per deployment, keyed `pk`/`sk`, with the two general
 * indexes, the sparse `pending` index the relay reads, and the TTL attribute. This is the schema's one
 * source in code: the tests and the dev script create the table from it against DynamoDB Local, and the
 * Terraform module (`terraform/table.tf`) declares the same shape for a deployment — the README says the
 * two must match, and a reviewer compares them by eye.
 *
 * Every item carries `kind` (the item type — `user`, `session`, `outbox`, `unique`, …). The realm's own
 * items live under `realm#<kind>` with the document id as `sk`; maestro's record — principals, the
 * outbox, its counters — under `ws#<workspace_id>#<kind>`. A `unique` item claims a value that must be
 * one-of-a-kind (an email, a code digest, a principal binding, an authorization handle) and names its
 * owner, so it is both the constraint and the lookup — written in the same transaction as the owner,
 * read with strong consistency.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
  type CreateTableCommandInput,
  type DynamoDBClient,
  type TableDescription
} from '@aws-sdk/client-dynamodb';

export const KEY = { pk: 'pk', sk: 'sk' } as const;

export const INDEXES = {
  /** A second access path per kind: a credential by application, a refresh token by its hash. */
  gsi1: { name: 'gsi1', pk: 'gsi1pk', sk: 'gsi1sk' },
  /** A time-ordered path per kind: a token by type and issue time. */
  gsi2: { name: 'gsi2', pk: 'gsi2pk', sk: 'gsi2sk' },
  /** Sparse: only an undelivered outbox item carries these; delivering it removes them (ADR-0022 §5). */
  pending: { name: 'pending', pk: 'pending_pk', sk: 'pending_sk' }
} as const;

/** Epoch seconds. Set on sessions, tokens and authorizations; absent elsewhere (ADR-0023 §4). */
export const TTL_ATTRIBUTE = 'expires_at';

/** The `CreateTable` input for a table of this shape — what DynamoDB Local is given; Terraform mirrors it. */
export function createTableInput(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: KEY.pk, AttributeType: 'S' },
      { AttributeName: KEY.sk, AttributeType: 'S' },
      { AttributeName: INDEXES.gsi1.pk, AttributeType: 'S' },
      { AttributeName: INDEXES.gsi1.sk, AttributeType: 'S' },
      { AttributeName: INDEXES.gsi2.pk, AttributeType: 'S' },
      { AttributeName: INDEXES.gsi2.sk, AttributeType: 'S' },
      { AttributeName: INDEXES.pending.pk, AttributeType: 'S' },
      { AttributeName: INDEXES.pending.sk, AttributeType: 'S' }
    ],
    KeySchema: [
      { AttributeName: KEY.pk, KeyType: 'HASH' },
      { AttributeName: KEY.sk, KeyType: 'RANGE' }
    ],
    GlobalSecondaryIndexes: [INDEXES.gsi1, INDEXES.gsi2, INDEXES.pending].map((index) => ({
      IndexName: index.name,
      KeySchema: [
        { AttributeName: index.pk, KeyType: 'HASH' },
        { AttributeName: index.sk, KeyType: 'RANGE' }
      ],
      Projection: { ProjectionType: 'ALL' }
    }))
  };
}

/** A table whose shape is not this code's: refused at boot, before a request could read the wrong index. */
export class TableShapeMismatch extends Error {
  constructor(tableName: string, public readonly differences: string[]) {
    super(`table ${tableName} does not have the shape service/src/db/table.ts declares: ${differences.join('; ')}`);
    this.name = 'TableShapeMismatch';
  }
}

/**
 * The differences between a described table and the shape this code expects: the key schema and every
 * index's name and keys. Empty when the table is the module's (or `ensureTable`'s). What `connect`
 * refuses on, so a table made by hand — or by an older module — fails the start, not the first query.
 */
export function tableShapeDifferences(table: TableDescription): string[] {
  const expected = createTableInput('');
  const out: string[] = [];
  const keys = (schema: { AttributeName?: string; KeyType?: string }[] | undefined) =>
    (schema ?? []).map((k) => `${k.KeyType}:${k.AttributeName}`).sort().join(',');
  if (keys(table.KeySchema) !== keys(expected.KeySchema)) out.push(`key schema is ${keys(table.KeySchema) || 'absent'}, expected ${keys(expected.KeySchema)}`);
  const actual = new Map((table.GlobalSecondaryIndexes ?? []).map((i) => [i.IndexName ?? '', keys(i.KeySchema)]));
  for (const index of expected.GlobalSecondaryIndexes ?? []) {
    const name = index.IndexName ?? '';
    if (!actual.has(name)) out.push(`index ${name} is missing`);
    else if (actual.get(name) !== keys(index.KeySchema)) out.push(`index ${name} is keyed ${actual.get(name)}, expected ${keys(index.KeySchema)}`);
  }
  for (const name of actual.keys()) {
    if (!(expected.GlobalSecondaryIndexes ?? []).some((i) => i.IndexName === name)) out.push(`index ${name} is not declared`);
  }
  return out;
}

/**
 * Reach the table and check its shape (ADR-0023 §5): what `Store.connect` runs at boot. Returns the
 * description; throws `TableShapeMismatch` when the keys or indexes are not this code's, and any SDK
 * error when the table is unreachable or absent. A TTL that is off is a warning the caller logs, not a
 * refusal: the table works, it only keeps what it should have swept.
 */
export async function describeAndCheck(client: DynamoDBClient, tableName: string): Promise<{ table: TableDescription; warnings: string[] }> {
  const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const table = described.Table;
  if (!table) throw new Error(`table ${tableName} has no description`);
  const differences = tableShapeDifferences(table);
  if (differences.length) throw new TableShapeMismatch(tableName, differences);
  const warnings: string[] = [];
  const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
  const spec = ttl.TimeToLiveDescription;
  if (spec?.TimeToLiveStatus !== 'ENABLED' || spec.AttributeName !== TTL_ATTRIBUTE) {
    warnings.push(`TTL on ${TTL_ATTRIBUTE} is ${spec?.TimeToLiveStatus ?? 'unknown'}${spec?.AttributeName ? ` (on ${spec.AttributeName})` : ''}; sessions, tokens and logins will not be swept`);
  }
  return { table, warnings };
}

/**
 * Create the table if it does not exist and turn its TTL on — for DynamoDB Local (the tests, the dev
 * script, the compose loop). A deployment's table is the Terraform module's; the service never creates it.
 */
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new CreateTableCommand(createTableInput(tableName)));
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
  }
  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName });
  const described = await client.send(new DescribeTableCommand({ TableName: tableName }));
  if (described.Table?.TableStatus !== 'ACTIVE') throw new Error(`table ${tableName} is ${described.Table?.TableStatus}`);
  try {
    await client.send(new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true }
    }));
  } catch (err) {
    // Already enabled (a second `ensureTable` on the same table): DynamoDB refuses the no-op.
    if (!/TimeToLive is already enabled/i.test((err as Error).message ?? '')) throw err;
  }
}

/** Drop a table — what a test does with the one it made. Absent is fine. */
export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return;
    throw err;
  }
  await waitUntilTableNotExists({ client, maxWaitTime: 60 }, { TableName: tableName });
}
