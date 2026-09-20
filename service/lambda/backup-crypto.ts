/**
 * Optional application-level encryption of a backup object: AES-256-GCM under a key derived with
 * scrypt from a passphrase the tenant holds in Secrets Manager — the same construction the service uses
 * for signing keys at rest (src/utils/key-store.ts), so one habit covers both. Layout of an `.enc`
 * object: magic(4) | salt(16) | iv(12) | tag(16) | ciphertext. Each object gets its own salt and iv.
 *
 * Without a passphrase a backup relies on the bucket alone: SSE, no public access, TLS-only, and the
 * IAM that can read it — the same posture as the plaintext backup.sh path of ADR-0008.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('ISB1'); // identity-service backup, layout 1
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackup(stored: Buffer, passphrase: string): Buffer {
  if (stored.length < MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES || !stored.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not an identity-service backup object (bad magic)');
  }
  let offset = MAGIC.length;
  const salt = stored.subarray(offset, (offset += SALT_BYTES));
  const iv = stored.subarray(offset, (offset += IV_BYTES));
  const tag = stored.subarray(offset, (offset += TAG_BYTES));
  const ciphertext = stored.subarray(offset);
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
