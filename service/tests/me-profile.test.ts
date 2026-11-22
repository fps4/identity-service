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
import { createMeRouter } from '../src/routes/me-routes.js';
import { NAME_MAX_LENGTH } from '../src/services/users.js';
import { ActRefused, type RecordConfig } from '../src/record/index.js';
import type { SpineEvent } from '@fps4/maestro-spine';
import { fixtures } from './helpers/fixtures.js';
import { testStore, type TestStore } from './helpers/store.js';

/**
 * A person's name (maestro ADR-0062 §2): read and set on `/v1/me` with their own token, never a
 * machine's, and recorded as an act on a user without the name ever entering an event body.
 */
describe('/v1/me — the person\'s name', () => {
  const record: RecordConfig = { workspaceId: 'ws-identity-test', consequenceClass: 'c1' };
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

  const call = (method: 'GET' | 'PUT', token?: string, body?: unknown, contentType = 'application/json') =>
    fetch(`${base}/v1/me`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': contentType } : {})
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
    });

  const events = async () => (await db.store.outbox.list()) as unknown as SpineEvent[];

  beforeEach(async () => {
    db = await testStore(record.workspaceId);
    await fixtures.application(db.store, { _id: 'maestro', name: 'maestro', audience: 'maestro' });
    await fixtures.user(db.store, { _id: 'user-local', email: 'a@x.test' });
    await fixtures.user(db.store, {
      _id: 'user-fed',
      email: 'b@x.test',
      name: 'Bea',
      identities: [{ provider: 'google', subject: 'google-sub-b', emailVerified: true, linkedAt: new Date() }]
    });
    await fixtures.user(db.store, { _id: 'user-off', email: 'c@x.test', status: 'disabled' });
    const app = express();
    app.use(express.json({ limit: '512kb' }));
    app.use('/v1/me', createMeRouter({ store: db.store, verifyToken: verifyOwnToken, record }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.drop();
  });

  it('AC-1: GET answers the email and the name — null when none is set — with no-store', async () => {
    const none = await call('GET', await sign({ sub: 'user-local' }));
    expect(none.status).toBe(200);
    expect(none.headers.get('cache-control')).toBe('no-store');
    expect(await none.json()).toEqual({ email: 'a@x.test', name: null });

    // A federated person is the same person, found through their linked identity.
    expect(await (await call('GET', await sign({ sub: 'google-sub-b' }))).json()).toEqual({ email: 'b@x.test', name: 'Bea' });
  });

  it('AC-2: PUT keeps the name trimmed, and the next GET returns it', async () => {
    const token = await sign({ sub: 'user-local' });
    const put = await call('PUT', token, { name: '  Jan Dekker  ' });
    expect(put.status).toBe(200);
    expect(put.headers.get('cache-control')).toBe('no-store');
    expect(await put.json()).toEqual({ email: 'a@x.test', name: 'Jan Dekker' });
    expect(await (await call('GET', token)).json()).toEqual({ email: 'a@x.test', name: 'Jan Dekker' });
    expect((await db.store.users.get('user-local'))!.name).toBe('Jan Dekker');
    // A name may be in any script, and as long as the limit.
    expect((await call('PUT', token, { name: 'Zoë 李' })).status).toBe(200);
    expect((await call('PUT', token, { name: 'x'.repeat(NAME_MAX_LENGTH) })).status).toBe(200);
    // A trimmed newline is whitespace, not part of the name.
    expect(await (await call('PUT', token, { name: '\nJan Dekker\n' })).json()).toEqual({ email: 'a@x.test', name: 'Jan Dekker' });
  });

  it('AC-2: the limit counts characters, not UTF-16 units — 80 astral characters are kept, 81 refused', async () => {
    const token = await sign({ sub: 'user-local' });
    const kept = '𝔍'.repeat(NAME_MAX_LENGTH);
    expect(kept.length).toBe(NAME_MAX_LENGTH * 2);
    expect(await (await call('PUT', token, { name: kept })).json()).toEqual({ email: 'a@x.test', name: kept });
    expect((await call('PUT', token, { name: '𝔍'.repeat(NAME_MAX_LENGTH + 1) })).status).toBe(400);
    expect((await db.store.users.get('user-local'))!.name).toBe(kept);
  });

  it('AC-2: a name with no letter, an empty or too long one, or not a string is refused (400) and nothing changes', async () => {
    const token = await sign({ sub: 'user-fed' });
    const bads = [
      '', '   ', '1234', '-- ?!', 'x'.repeat(NAME_MAX_LENGTH + 1), `  ${'x'.repeat(NAME_MAX_LENGTH + 1)}  `, 42, null, ['Jan'], undefined,
      'Jan\nDekker', 'Jan\r\nDekker', 'Jan\tDekker', 'Jan\u0000Dekker', // control characters
      'Jan\u202eDekker', 'Jan\u2066Dekker',                              // bidi override and isolate (format)
      'Jan\u200bDekker', '\u200b', 'Jan\ufeffDekker', 'Jan\u00adDekker', // zero-width space, BOM, soft hyphen (format)
      'Jan\ue000Dekker',                                                   // private use
      'Jan\ud800Dekker'                                                    // a lone surrogate
    ];
    for (const bad of bads) {
      const res = await call('PUT', token, { name: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('PUT', token, [1])).status).toBe(400);
    expect((await call('PUT', token, 'Jan', 'text/plain')).status).toBe(400);
    expect((await db.store.users.get('user-fed'))!.name).toBe('Bea');
    expect(await events()).toEqual([]);
  });

  it('AC-4: a machine token, a token naming no active user, and no token are refused', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const body = method === 'PUT' ? { name: 'Jan' } : undefined;
      expect((await call(method, undefined, body)).status).toBe(401);
      expect((await call(method, await sign({ sub: 'user-local' }, 'https://someone-else.test'), body)).status).toBe(401);
      expect((await call(method, await sign({ cid: 'svc', sub: 'svc' }), body)).status).toBe(403);
      expect((await call(method, await sign({ sub: 'nobody' }), body)).status).toBe(403);
      expect((await call(method, await sign({ sub: 'user-off' }), body)).status).toBe(403);
    }
    expect((await db.store.users.get('user-off'))!.name).toBeUndefined();
  });

  it('records a change as PrincipalProfileChanged by the person themselves — once per change, never with the name', async () => {
    const token = await sign({ sub: 'user-local' });
    await call('PUT', token, { name: 'Jan Dekker' });
    await call('PUT', token, { name: ' Jan Dekker ' }); // the same name: nothing changed, nothing recorded
    expect(await events()).toHaveLength(1);
    await call('PUT', token, { name: 'Jan de Vries' });

    const user = (await db.store.users.get('user-local'))!;
    expect(user.principalId).toMatch(/^prn-h-/);
    const recorded = await events();
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      workspace_id: 'ws-identity-test',
      subject_type: 'principal',
      subject_id: user.principalId,
      type: 'PrincipalProfileChanged',
      acting: user.principalId,
      accountable: user.principalId,
      seat: 'self',
      oversight_level: 'O0',
      body: { field: 'name' }
    });
    expect(recorded[1].subject_seq).toBe(recorded[0].subject_seq + 1);
    expect(JSON.stringify(recorded)).not.toMatch(/Jan|Vries|a@x\.test/);
  });

  it('AC-5: the preferences routes under /v1/me answer as before', async () => {
    const token = await sign({ sub: 'user-local' });
    await call('PUT', token, { name: 'Jan Dekker' });
    const prefs = await fetch(`${base}/v1/me/preferences/maestro`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ console: { board: {} } })
    });
    expect(prefs.status).toBe(200);
    expect(await (await fetch(`${base}/v1/me/preferences/maestro`, { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ console: { board: {} } });
  });

  it('stores the name without the record when none is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use('/v1/me', createMeRouter({ store: db.store, verifyToken: verifyOwnToken }));
    const bare = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}/v1/me`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await sign({ sub: 'user-local' })}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Jan' })
      });
      expect(res.status).toBe(200);
      expect((await db.store.users.get('user-local'))!.name).toBe('Jan');
      expect(await events()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });

  describe('when the act fails', () => {
    const serve = async (users: { setName: (...args: any[]) => Promise<string> }) => {
      const app = express();
      app.use(express.json());
      app.use('/v1/me', createMeRouter({ store: db.store, verifyToken: verifyOwnToken, record, users }));
      const s = await new Promise<Server>((resolve) => {
        const srv = app.listen(0, () => resolve(srv));
      });
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/me` };
    };
    const put = async (users: { setName: (...args: any[]) => Promise<string> }) => {
      const { s, url } = await serve(users);
      try {
        return await fetch(url, {
          method: 'PUT',
          headers: { authorization: `Bearer ${await sign({ sub: 'user-local' })}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Jan' })
        });
      } finally {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    };

    it('answers 403 with the reason when the record refuses the act (ActRefused)', async () => {
      const res = await put({ setName: async () => { throw new ActRefused('The record refuses this act.'); } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'act_refused', error_description: 'The record refuses this act.' });
    });

    it('answers 500 for any other failure, and never leaves the request unanswered', async () => {
      const res = await put({ setName: async () => { throw new Error('the table is gone'); } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'server_error', error_description: 'Internal Server Error' });
    });
  });
});
