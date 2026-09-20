/**
 * The scheduled backup as a Lambda (maestro M1, ADR-0008's job on S3; ADR-0023). The live table is the
 * system of record; this writes a point-in-time copy of every item — users, applications, credentials,
 * assignments, issued tokens, lockouts, the signing-key history, the audit log, the record's outbox and
 * registry — to S3 under backups/<yyyy-mm-dd>/, as gzipped canonical JSON lines, one file per item
 * `kind`, plus a manifest. Point-in-time recovery, which the module turns on, is the second line: this
 * copy is what survives the table itself, and what an operator reads without DynamoDB.
 *
 * A line is the item exactly as the table holds it, keys and index attributes included, as JSON with
 * its keys sorted — so a restore is a `PutItem` per line and two backups of the same item are the same
 * bytes. Numbers are DynamoDB numbers (`wrapNumbers`), written as JSON numbers; nothing this service
 * stores exceeds a double. Signing keys are stored encrypted under OAUTH_KEY_PASSPHRASE and are copied
 * as stored: a restore needs the same passphrase, not this one.
 *
 * Environment (set by the Terraform module): TABLE_NAME, BACKUP_BUCKET, BACKUP_PREFIX (default
 * `backups`), and optionally BACKUP_PASSPHRASE (a secret) — when present each object is additionally
 * encrypted with AES-256-GCM (backup-crypto.ts) and named `.enc`. The function's role may Scan and
 * DescribeTable the table and put under the prefix; nothing else. Errors propagate: a failed run is a
 * Lambda error, which the module's alarm reports.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { encryptBackup } from './backup-crypto.js';

interface KindEntry {
  kind: string;
  items: number;
  key: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  table: string;
  takenAt: string;
  format: 'dynamodb-items-jsonl+gzip';
  encryption: 'aes-256-gcm/scrypt' | null;
  itemCount: number;
  kinds: KindEntry[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** JSON with the keys of every object sorted, so the same item is always the same line. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export async function handler(): Promise<BackupManifest> {
  const table = required('TABLE_NAME');
  const bucket = required('BACKUP_BUCKET');
  const prefix = (process.env.BACKUP_PREFIX || 'backups').replace(/\/+$/, '');
  const passphrase = process.env.BACKUP_PASSPHRASE || '';

  const takenAt = new Date();
  const day = takenAt.toISOString().slice(0, 10);
  const s3 = new S3Client({});
  const dynamo = new DynamoDBClient({ ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}) });
  const doc = DynamoDBDocumentClient.from(dynamo, { unmarshallOptions: { wrapNumbers: false } });

  await dynamo.send(new DescribeTableCommand({ TableName: table }));

  // The whole table, paged, grouped by kind in memory: an identity realm is small, and the module sizes
  // the function for it (backup_memory_mb).
  const byKind = new Map<string, string[]>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(new ScanCommand({ TableName: table, ConsistentRead: true, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }));
    for (const item of page.Items ?? []) {
      const kind = typeof item.kind === 'string' ? item.kind : 'unknown';
      (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(canonicalJson(item));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  const kinds: KindEntry[] = [];
  for (const kind of [...byKind.keys()].sort()) {
    const lines = byKind.get(kind)!;
    const plain = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
    const body = passphrase ? encryptBackup(plain, passphrase) : plain;
    const key = `${prefix}/${day}/${kind}.jsonl.gz${passphrase ? '.enc' : ''}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: passphrase ? 'application/octet-stream' : 'application/gzip'
      })
    );
    kinds.push({ kind, items: lines.length, key, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }

  const manifest: BackupManifest = {
    table,
    takenAt: takenAt.toISOString(),
    format: 'dynamodb-items-jsonl+gzip',
    encryption: passphrase ? 'aes-256-gcm/scrypt' : null,
    itemCount: kinds.reduce((n, k) => n + k.items, 0),
    kinds
  };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/${day}/manifest.json`,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json'
    })
  );
  console.log(JSON.stringify({ msg: 'backup written', table, day, kinds: kinds.length, items: manifest.itemCount }));
  return manifest;
}
