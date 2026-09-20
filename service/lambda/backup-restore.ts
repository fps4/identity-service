/**
 * Restore one backup file — the `<kind>.jsonl` a backup wrote, decompressed (and decrypted, if it was
 * encrypted) — into the table: a `PutItem` per line, in batches, each item exactly as it was. Items
 * present in the table and absent from the file are left alone; drop the table's contents first for
 * a clean restore. Runs where the operator's AWS credentials reach the table (or DynamoDB Local).
 *
 *   TABLE_NAME=… npm run backup:restore -- user.jsonl [oauth_client.jsonl …]
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const files = process.argv.slice(2);
const table = process.env.TABLE_NAME;
if (!table || files.length === 0) {
  console.error('usage: TABLE_NAME=… tsx lambda/backup-restore.ts <kind.jsonl> …');
  process.exit(2);
}

const client = new DynamoDBClient({ ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}) });
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

async function flush(items: Record<string, unknown>[]): Promise<void> {
  let pending = items.map((Item) => ({ PutRequest: { Item } }));
  while (pending.length) {
    const out = await doc.send(new BatchWriteCommand({ RequestItems: { [table!]: pending } }));
    pending = (out.UnprocessedItems?.[table!] as typeof pending | undefined) ?? [];
  }
}

let restored = 0;
for (const file of files) {
  let batch: Record<string, unknown>[] = [];
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    if (batch.length === 25) { await flush(batch); restored += batch.length; batch = []; }
  }
  if (batch.length) { await flush(batch); restored += batch.length; }
  console.log(`${file}: restored`);
}
console.log(`${restored} item(s) restored into ${table}`);
