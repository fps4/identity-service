import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { SignJWT } from 'jose';

// Tokens are verified against the service's own JWKS: mock the key store with a known test key.
const { privateKey: testPrivateKeyPem, publicKey: testPublicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const testJwk = createPublicKey(testPublicKeyPem).export({ format: 'jwk' }) as Record<string, string>;

vi.mock('../src/utils/key-store.js', () => ({
  listPublicKeys: vi.fn(async () => [{ kid: 'test-kid', kty: 'RSA', alg: 'RS256', use: 'sig', n: testJwk.n, e: testJwk.e }])
}));

import { CONFIG } from '../src/config.js';
import { verifyOwnToken } from '../src/core/own-token.js';
import { createMeRouter, PREFERENCES_MAX_BYTES } from '../src/routes/me-routes.js';
import { fixtures } from './helpers/fixtures.js';
import { testStore, type TestStore } from './helpers/store.js';

/**
 * A person's preferences (maestro ADR-0029): read and replaced with their own token, per application,
 * never a machine's and never another person's.
 */
describe('/v1/me/preferences', () => {
  let db: TestStore;
  let server: Server;
  let base: string;

  const sign = (claims: Record<string, unknown>, issuer = CONFIG.auth.jwtIssuer) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience('maestro')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(createPrivateKey(testPrivateKeyPem));

  const call = (method: 'GET' | 'PUT', application: string, token?: string, body?: unknown, contentType = 'application/json') =>
    fetch(`${base}/v1/me/preferences/${application}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': contentType } : {})
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });

  beforeEach(async () => {
    db = await testStore();
    await fixtures.application(db.store, { _id: 'maestro', name: 'maestro', audience: 'maestro' });
    await fixtures.application(db.store, { _id: 'other-app', name: 'other', audience: 'other' });
    await fixtures.user(db.store, { _id: 'user-local', email: 'a@x.test' });
    await fixtures.user(db.store, {
      _id: 'user-fed',
      email: 'b@x.test',
      identities: [{ provider: 'google', subject: 'google-sub-b', emailVerified: true, linkedAt: new Date() }]
    });
    await fixtures.user(db.store, { _id: 'user-off', email: 'c@x.test', status: 'disabled' });
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use('/v1/me', createMeRouter({ store: db.store, verifyToken: verifyOwnToken }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.drop();
  });

  it('reads {} before anything is stored, then what the person stored, per application', async () => {
    const token = await sign({ sub: 'user-local', email: 'a@x.test', prn: 'prn-h-a' });
    expect(await (await call('GET', 'maestro', token)).json()).toEqual({});

    const prefs = { console: { owed: { who: 'mine', application: 'app1' }, board: {} } };
    const put = await call('PUT', 'maestro', token, prefs);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(prefs);

    const got = await call('GET', 'maestro', token);
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(await got.json()).toEqual(prefs);
    // Namespaced: another application's document is its own.
    expect(await (await call('GET', 'other-app', token)).json()).toEqual({});

    // A PUT replaces the document; it does not merge.
    await call('PUT', 'maestro', token, { console: { board: { application: 'app2' } } });
    expect(await (await call('GET', 'maestro', token)).json()).toEqual({ console: { board: { application: 'app2' } } });
    const stored = await db.store.preferences.get('user-local', 'maestro');
    expect(stored).toMatchObject({ userId: 'user-local', applicationId: 'maestro' });
    expect(stored!.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps strings the application stored as strings, dates or not', async () => {
    const token = await sign({ sub: 'user-local' });
    const prefs = { pinnedAt: '2026-09-27T10:00:00Z' };
    await call('PUT', 'maestro', token, prefs);
    expect(await (await call('GET', 'maestro', token)).json()).toEqual(prefs);
  });

  it('knows a federated person by their linked identity, and each person sees only their own', async () => {
    const federated = await sign({ sub: 'google-sub-b', email: 'b@x.test' });
    await call('PUT', 'maestro', federated, { mine: 'b' });
    expect(await db.store.preferences.get('user-fed', 'maestro')).toMatchObject({ preferences: { mine: 'b' } });
    const local = await sign({ sub: 'user-local' });
    expect(await (await call('GET', 'maestro', local)).json()).toEqual({});
  });

  it('refuses a missing or foreign token (401), a machine or an unknown or disabled person (403)', async () => {
    expect((await call('GET', 'maestro')).status).toBe(401);
    expect((await call('GET', 'maestro', await sign({ sub: 'user-local' }, 'https://someone-else.test'))).status).toBe(401);
    expect((await call('GET', 'maestro', await sign({ cid: 'svc', sub: 'svc' }))).status).toBe(403);
    expect((await call('GET', 'maestro', await sign({ sub: 'nobody' }))).status).toBe(403);
    expect((await call('GET', 'maestro', await sign({ sub: 'user-off' }))).status).toBe(403);
  });

  it('refuses an application the realm does not know (404), and a body that is not a small JSON object', async () => {
    const token = await sign({ sub: 'user-local' });
    expect((await call('GET', 'ghost', token)).status).toBe(404);
    expect((await call('PUT', 'ghost', token, {})).status).toBe(404);
    expect((await call('PUT', 'maestro', token, [1, 2])).status).toBe(400);
    expect((await call('PUT', 'maestro', token, 'plain', 'text/plain')).status).toBe(400);
    const tooBig = { blob: 'x'.repeat(PREFERENCES_MAX_BYTES) };
    const res = await call('PUT', 'maestro', token, tooBig);
    expect(res.status).toBe(413);
    expect(await db.store.preferences.get('user-local', 'maestro')).toBeNull();
  });
});
