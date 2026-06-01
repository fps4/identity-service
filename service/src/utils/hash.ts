import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';

const SCRYPT_KEY_LEN = 64;

/**
 * Deterministic hash for high-entropy opaque tokens (refresh tokens) so they can be looked up by
 * hash without storing the raw value. NOT for low-entropy secrets — those use {@link hashSecret}
 * (salted scrypt). Deterministic is required here: lookup hashes the presented token and matches.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(secret, salt, SCRYPT_KEY_LEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifySecret(secret: string, storedHash: string): boolean {
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const derived = scryptSync(secret, salt, SCRYPT_KEY_LEN);
  const stored = Buffer.from(keyHex, 'hex');
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}
