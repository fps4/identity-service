import { generateKeyPairSync, randomUUID, createPublicKey, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { getMasterConnection } from './db.js';
import { makeModels } from '../models/index.js';
import logger from './logger.js';
import { CONFIG } from '../config.js';

interface ActiveKey {
  kid: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export async function ensureActiveSigningKey(): Promise<ActiveKey> {
  const connection = await getMasterConnection();
  const { KeyStore } = makeModels(connection);

  const active = await KeyStore.findOne({ status: 'active' }).sort({ createdAt: -1 }).lean().exec();
  if (active) {
    return {
      kid: active.kid,
      privateKeyPem: decryptPrivateKey(active.privateKey),
      publicKeyPem: active.publicKey
    };
  }

  const { privateKey, publicKey, kid } = createKeyPair();
  await KeyStore.create({
    kid,
    privateKey: encryptPrivateKey(privateKey),
    publicKey,
    algorithm: 'RS256',
    status: 'active'
  });

  logger.info({ kid }, 'generated initial signing key');

  return { kid, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export async function rotateSigningKey(): Promise<ActiveKey> {
  const connection = await getMasterConnection();
  const { KeyStore } = makeModels(connection);

  const { privateKey, publicKey, kid } = createKeyPair();

  const session = await connection.startSession();
  await session.withTransaction(async () => {
    await KeyStore.updateMany({ status: 'active' }, { $set: { status: 'inactive', rotatedAt: new Date() } }).session(session);
    await KeyStore.create([{
      kid,
      privateKey: encryptPrivateKey(privateKey),
      publicKey,
      algorithm: 'RS256',
      status: 'active'
    }], { session });
  });
  session.endSession();

  logger.info({ kid }, 'rotated signing key');

  return { kid, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

export async function listPublicKeys() {
  const connection = await getMasterConnection();
  const { KeyStore } = makeModels(connection);
  const keys = await KeyStore.find({ status: { $in: ['active', 'inactive'] } }).lean().exec();

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
