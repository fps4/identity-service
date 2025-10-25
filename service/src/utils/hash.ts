import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_KEY_LEN = 64;

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
