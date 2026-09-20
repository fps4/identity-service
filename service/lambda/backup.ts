/**
 * The scheduled backup as a Lambda (maestro M1, ADR-0008's job on S3). The live database is the system
 * of record; this writes a point-in-time copy of every collection — users, applications, credentials,
 * assignments, issued tokens, lockouts, the signing-key history, the audit log — to S3 under
 * backups/<yyyy-mm-dd>/, one gzipped file of canonical Extended JSON lines per collection plus a
 * manifest. docker/backup.sh does the same with mongodump inside the mongo container; a Lambda has no
 * mongodump, so this speaks the driver and writes a format mongoimport reads back:
 *
 *   mongoimport --uri "$MONGO_URI/$MONGO_DB_NAME" --collection <name> --drop --file <name>.jsonl
 *
 * Canonical Extended JSON (relaxed=false, values not promoted) keeps every BSON type as it was — an
 * Int32 stays an Int32, a Long a Long — so a restore is byte-for-byte the same documents. Signing keys
 * are stored encrypted under OAUTH_KEY_PASSPHRASE and are copied as stored: a restore needs the same
 * passphrase, not this one.
 *
 * Environment (set by the Terraform module): MONGO_URI (a secret), MONGO_DB_NAME, BACKUP_BUCKET,
 * BACKUP_PREFIX (default `backups`), and optionally BACKUP_PASSPHRASE (a secret) — when present each
 * object is additionally encrypted with AES-256-GCM (backup-crypto.ts) and named `.enc`. Errors
 * propagate: a failed run is a Lambda error, which the module's alarm reports.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import mongoose from 'mongoose';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { encryptBackup } from './backup-crypto.js';

const { EJSON } = mongoose.mongo.BSON;

interface CollectionEntry {
  name: string;
  documents: number;
  key: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  database: string;
  takenAt: string;
  format: 'ejson-canonical-jsonl+gzip';
  encryption: 'aes-256-gcm/scrypt' | null;
  collections: CollectionEntry[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function handler(): Promise<BackupManifest> {
  const mongoUri = required('MONGO_URI');
  const dbName = process.env.MONGO_DB_NAME || 'identity-service';
  const bucket = required('BACKUP_BUCKET');
  const prefix = (process.env.BACKUP_PREFIX || 'backups').replace(/\/+$/, '');
  const passphrase = process.env.BACKUP_PASSPHRASE || '';

  const takenAt = new Date();
  const day = takenAt.toISOString().slice(0, 10);
  const s3 = new S3Client({});
  const connection = await mongoose.createConnection(`${mongoUri}/${dbName}`, { maxPoolSize: 2, autoIndex: false }).asPromise();

  try {
    const db = connection.db;
    if (!db) throw new Error('no database handle after connect');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith('system.'))
      .sort();

    const collections: CollectionEntry[] = [];
    for (const name of names) {
      const lines: string[] = [];
      const cursor = db.collection(name).find({}, { promoteValues: false, promoteLongs: false });
      for await (const doc of cursor) lines.push(EJSON.stringify(doc, { relaxed: false }));
      const plain = gzipSync(Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8'));
      const body = passphrase ? encryptBackup(plain, passphrase) : plain;
      const key = `${prefix}/${day}/${name}.jsonl.gz${passphrase ? '.enc' : ''}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: passphrase ? 'application/octet-stream' : 'application/gzip'
        })
      );
      collections.push({ name, documents: lines.length, key, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    }

    const manifest: BackupManifest = {
      database: dbName,
      takenAt: takenAt.toISOString(),
      format: 'ejson-canonical-jsonl+gzip',
      encryption: passphrase ? 'aes-256-gcm/scrypt' : null,
      collections
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/${day}/manifest.json`,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json'
      })
    );
    console.log(JSON.stringify({ msg: 'backup written', database: dbName, day, collections: collections.length, documents: collections.reduce((n, c) => n + c.documents, 0) }));
    return manifest;
  } finally {
    await connection.close();
  }
}
