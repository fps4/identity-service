import { generateKeyPairSync, randomUUID, createPublicKey, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { ConditionFailed, getStore } from '../db/index.js';
import logger from './logger.js';
import { CONFIG } from '../config.js';

interface ActiveKey {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function ensureActiveSigningKey(): Promise<ActiveKey> {
  const keys = getStore().signingKeys;

  const active = await keys.getActive();
  if (active) {
    return {
      kid: active.kid,
      privateKeyPem: decryptPrivateKey(active.privateKey),
      publicKeyPem: active.publicKey
    };
  }

  const { privateKey, publicKey, kid } = createKeyPair();
  try {
    await keys.create({
      kid,
      privateKey: encryptPrivateKey(privateKey),
      publicKey,
      algorithm: 'RS256',
      status: 'active',
      createdAt: new Date(),
      rotatedAt: null
    });
  } catch (err) {
    // Two cold starts generating the first key at once: the kid is a UUID, so a failed put is not this
    // key — re-read and use whatever is active now.
    if (!(err instanceof ConditionFailed)) throw err;
    return ensureActiveSigningKey();
  }

  logger.info({ kid }, 'generated initial signing key');

  return { kid, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export async function rotateSigningKey(): Promise<ActiveKey> {
  const keys = getStore().signingKeys;

  const { privateKey, publicKey, kid } = createKeyPair();
  const now = new Date();
  // One transaction: every active key demoted, the new one inserted. The JWKS publishes both active and
  // inactive keys, so a token signed by the just-demoted key still verifies (ADR rotation rule).
  const active = (await keys.listPublishable()).filter((k) => k.status === 'active').map((k) => k.kid);
  await keys.rotate(active, {
    kid,
    privateKey: encryptPrivateKey(privateKey),
    publicKey,
    algorithm: 'RS256',
    status: 'active',
    createdAt: now,
    rotatedAt: null
  }, now);

  logger.info({ kid }, 'rotated signing key');

  return { kid, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export async function listPublicKeys() {
  const keys = await getStore().signingKeys.listPublishable();

  return keys.map((item) => ({
    kid: item.kid,
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    ...exportPublicJwk(item.publicKey)
  }));
}

function createKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const kid = randomUUID();
  return { privateKey, publicKey, kid };
}

function exportPublicJwk(pem: string) {
  const publicKey = createPublicKey(pem);
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return {
    n: jwk.n,
    e: jwk.e
  };
}

export async function getActiveKeyPair(): Promise<ActiveKey> {
  const key = await ensureActiveSigningKey();
  return key;
}

function encryptPrivateKey(pem: string): string {
  const passphrase = CONFIG.oauth.key.encryptionPassphrase;
  if (!passphrase) return pem;

  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPrivateKey(stored: string): string {
  const passphrase = CONFIG.oauth.key.encryptionPassphrase;
  if (!stored.startsWith('enc:')) {
    return stored;
  }
  if (!passphrase) {
    throw new Error('Encrypted key present but OAUTH_KEY_PASSPHRASE not configured');
  }
  const parts = stored.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid encrypted key format');
  }
  const [, saltHex, ivHex, tagHex, dataHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
