import { jwtVerify, createLocalJWKSet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CONFIG } from '../config.js';
import { listPublicKeys } from '../utils/key-store.js';

/**
 * A token this service issued, verified the way a consumer would: its signature against this service's
 * OWN JWKS (the keys `/.well-known/jwks.json` publishes) and its `iss`. The admin plane and the person's
 * own routes (`/v1/me`) both read their principal from it; what each then requires of the claims is theirs.
 */

// Cache the local JWKS; refresh on a kid-miss so a key rotation is picked up without a restart.
let cachedJwks: JWTVerifyGetKey | null = null;
let cachedAt = 0;
const JWKS_TTL_MS = 60_000;

async function getJwks(forceRefresh = false): Promise<JWTVerifyGetKey> {
  const fresh = Date.now() - cachedAt < JWKS_TTL_MS;
  if (cachedJwks && fresh && !forceRefresh) return cachedJwks;
  const keys = await listPublicKeys();
  cachedJwks = createLocalJWKSet({ keys: keys as unknown as Parameters<typeof createLocalJWKSet>[0]['keys'] });
  cachedAt = Date.now();
  return cachedJwks;
}

/** The verified claims, or a throw. A key may have rotated since the JWKS was cached: refreshed once and retried. */
export async function verifyOwnToken(token: string): Promise<JWTPayload> {
  try {
    return (await jwtVerify(token, await getJwks(), { issuer: CONFIG.auth.jwtIssuer })).payload;
  } catch {
    return (await jwtVerify(token, await getJwks(true), { issuer: CONFIG.auth.jwtIssuer })).payload;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}
