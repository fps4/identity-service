import { createSecretKey } from 'crypto';
import { SignJWT } from 'jose';
import { MissingJwtSecretError } from './errors.js';
import type { SignSessionJwtArgs } from './types.js';

export interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
}

export type JwtConfigProvider = JwtConfig | (() => JwtConfig);

export function createSessionJwtSigner(config: JwtConfigProvider) {
  const resolve = typeof config === 'function' ? config : () => config;

  return async function signSessionJwt({
    sessionId,
    tenantId,
    subject = 'anonymous',
    expiresInSec
  }: SignSessionJwtArgs) {
    const cfg = resolve();
    if (!cfg.secret) {
      throw new MissingJwtSecretError();
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + Math.max(1, expiresInSec);

    const token = await new SignJWT({ sid: sessionId, tid: tenantId, sub: subject })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setJti(randomUuid())
      .setIssuer(cfg.issuer)
      .setAudience(cfg.audience)
      .sign(createSecretKey(Buffer.from(cfg.secret, 'utf-8')));

    return { token, exp } as const;
  };
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.random() * 16 | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}
