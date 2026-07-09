import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'crypto';
import { SignJWT } from 'jose';

// Mock the key store so admin-auth verifies against a known test key, and rotateKey is a no-op.
const { privateKey: testPrivateKeyPem, publicKey: testPublicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const testJwk = createPublicKey(testPublicKeyPem).export({ format: 'jwk' }) as Record<string, string>;

vi.mock('../src/utils/key-store.js', () => ({
  listPublicKeys: vi.fn(async () => [{ kid: 'test-kid', kty: 'RSA', alg: 'RS256', use: 'sig', n: testJwk.n, e: testJwk.e }]),
  rotateSigningKey: vi.fn(async () => ({ kid: 'rotated-kid', privateKeyPem: '', publicKeyPem: '' }))
}));

import { createAdminService, AdminServiceError } from '../src/services/admin.js';
import { requireAdmin, ADMIN_SCOPES } from '../src/core/admin-auth.js';
import { CONFIG } from '../src/config.js';
import { verifySecret } from '../src/utils/hash.js';

// --- A compact in-memory mongoose-ish collection supporting the methods admin.ts uses ---

const match = (doc: any, filter: Record<string, any>): boolean =>
  Object.entries(filter ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && '$gt' in v) return doc[k] != null && doc[k] > v.$gt;
    if (v && typeof v === 'object' && !Array.isArray(v) && '$in' in v) return Array.isArray(v.$in) && v.$in.includes(doc[k]);
    // Dotted path into the identities[] array (e.g. 'identities.subject').
    if (k.startsWith('identities.')) {
      const field = k.slice('identities.'.length);
      return Array.isArray(doc.identities) && doc.identities.some((i: any) => i[field] === v);
    }
    return doc[k] === v;
  });

function fakeCollection(items: any[]) {
  const exec = <T>(v: T) => ({ exec: async () => v, lean: function () { return this; }, select: function () { return this; } });
  return {
    _items: items,
    find: (filter: any = {}) => exec(items.filter((d) => match(d, filter))),
    findById: (id: string) => exec(items.find((d) => d._id === id) ?? null),
    findOne: (filter: any) => exec(items.find((d) => match(d, filter)) ?? null),
    countDocuments: (filter: any = {}) => ({ exec: async () => items.filter((d) => match(d, filter)).length }),
    create: async (doc: any) => {
      if (doc._id != null && items.some((d) => d._id === doc._id)) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      items.push({ ...doc });
      return doc;
    },
    findByIdAndDelete: (id: string) => {
      const i = items.findIndex((d) => d._id === id);
      const removed = i >= 0 ? items.splice(i, 1)[0] : null;
      return exec(removed);
    },
    findByIdAndUpdate: (id: string, update: any, opts: any = {}) => {
      let doc = items.find((d) => d._id === id);
      const set = update.$set ?? {};
      const onInsert = update.$setOnInsert ?? {};
      if (!doc) {
        if (!opts.upsert) return exec(null); // mongoose returns null when not found and not upserting
        doc = { _id: id, ...onInsert, ...set }; items.push(doc);
      } else { Object.assign(doc, set); }
      return exec(doc);
    },
    // The assignment upsert path (ADR-0019): match by filter, apply $set, create from $setOnInsert on miss.
    findOneAndUpdate: (filter: any, update: any, opts: any = {}) => {
      let doc = items.find((d) => match(d, filter));
      const set = update.$set ?? {};
      const onInsert = update.$setOnInsert ?? {};
      if (!doc) {
        if (!opts.upsert) return exec(null);
        doc = { ...onInsert, ...set }; items.push(doc);
      } else { Object.assign(doc, set); }
      return exec(doc);
    },
    deleteOne: (filter: any) => ({
      exec: async () => {
        const i = items.findIndex((d) => match(d, filter));
        if (i < 0) return { deletedCount: 0 };
        items.splice(i, 1);
        return { deletedCount: 1 };
      }
    }),
    deleteMany: (filter: any = {}) => ({
      exec: async () => {
        let deletedCount = 0;
        for (let i = items.length - 1; i >= 0; i--) {
          if (match(items[i], filter)) { items.splice(i, 1); deletedCount++; }
        }
        return { deletedCount };
      }
    }),
    updateOne: (filter: any, update: any) => ({
      exec: async () => {
        const doc = items.find((d) => match(d, filter));
        if (!doc) return { matchedCount: 0 };
        Object.assign(doc, update.$set ?? {});
        for (const [k, v] of Object.entries(update.$push ?? {})) {
          doc[k] = doc[k] ?? []; doc[k].push(v);
        }
        for (const [k, cond] of Object.entries(update.$pull ?? {})) {
          if (Array.isArray(doc[k])) doc[k] = doc[k].filter((el: any) => !match(el, cond as any));
        }
        return { matchedCount: 1 };
      }
    })
  };
}

function makeState() {
  return {
    // A default application (ADR-0020) so credentials — which now require an applicationId — can be
    // created against it. Its catalogue is used by the assign/roles tests.
    Application: fakeCollection([{ _id: 'default-app', name: 'Default App', audience: 'default-ws', roles: [{ key: 'member' }, { key: 'lead' }] }]),
    OAuthClient: fakeCollection([]),
    User: fakeCollection([]),
    Assignment: fakeCollection([]),
    OAuthToken: fakeCollection([]),
    KeyStore: fakeCollection([{ _id: 'k1', status: 'active' }])
  };
}

function makeAdmin(state: ReturnType<typeof makeState>) {
  return createAdminService({
    getMasterConnection: async () => ({}) as any,
    makeModels: () => state as any
  });
}

describe('admin service', () => {
  let state: ReturnType<typeof makeState>;
  beforeEach(() => { state = makeState(); });

  it('creates a credential under an application, returns the secret once, and stores only its hash', async () => {
    const admin = makeAdmin(state);
    const { clientId, secret } = await admin.createClient({ applicationId: 'default-app', name: 'svc', grantTypes: ['client_credentials'], scopes: ['admin'] });
    expect(secret).toBeTruthy();
    const stored = state.OAuthClient._items.find((c) => c._id === clientId);
    expect(stored.applicationId).toBe('default-app');
    expect(stored.secretHash).not.toContain(secret);
    expect(verifySecret(secret, stored.secretHash)).toBe(true);
    expect(stored).not.toHaveProperty('roles'); // the catalogue lives on the application now (ADR-0020)
  });

  it('refuses to create a credential against an unknown application', async () => {
    const admin = makeAdmin(state);
    await expect(admin.createClient({ applicationId: 'ghost', name: 'svc', grantTypes: ['client_credentials'] }))
      .rejects.toMatchObject({ status: 404, code: 'application_not_found' });
    // applicationId is required (ADR-0020).
    await expect(admin.createClient({ name: 'svc', grantTypes: ['client_credentials'] } as any))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('persists additive token claims on the created credential (product_runtime, ADR-0017)', async () => {
    const admin = makeAdmin(state);
    const { clientId } = await admin.createClient({
      applicationId: 'default-app', id: 'skills-coach-ds1', name: 'skills-coach@ds1 runtime',
      grantTypes: ['client_credentials'], audience: 'maestro-workspace',
      subject: 'runtime@skills-coach.fps4.nl',
      claims: { role: 'product_runtime', email: 'runtime@skills-coach.fps4.nl' }
    });
    const stored = state.OAuthClient._items.find((c) => c._id === clientId);
    expect(stored.claims).toEqual({ role: 'product_runtime', email: 'runtime@skills-coach.fps4.nl' });
  });

  it('rejects non-object claims', async () => {
    const admin = makeAdmin(state);
    await expect(admin.createClient({ applicationId: 'default-app', name: 'x', grantTypes: ['client_credentials'], claims: ['nope'] as any }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('honors an explicit client id and rejects reusing it', async () => {
    const admin = makeAdmin(state);
    const { clientId } = await admin.createClient({ applicationId: 'default-app', id: 'coach-web', name: 'Coach Web', grantTypes: ['password'], audience: 'coach-workspace' });
    expect(clientId).toBe('coach-web');
    expect(state.OAuthClient._items.find((c) => c._id === 'coach-web')).toBeTruthy();
    await expect(admin.createClient({ applicationId: 'default-app', id: 'coach-web', name: 'dupe', grantTypes: ['password'] }))
      .rejects.toMatchObject({ status: 409, code: 'client_exists' });
  });

  it('rotates a client secret and 404s on an unknown client', async () => {
    const admin = makeAdmin(state);
    const { clientId } = await admin.createClient({ applicationId: 'default-app', name: 'svc', grantTypes: ['client_credentials'] });
    const before = state.OAuthClient._items.find((c) => c._id === clientId).secretHash;
    const { secret } = await admin.rotateClientSecret(clientId);
    const after = state.OAuthClient._items.find((c) => c._id === clientId).secretHash;
    expect(after).not.toBe(before);
    expect(verifySecret(secret, after)).toBe(true);
    await expect(admin.rotateClientSecret('nope')).rejects.toBeInstanceOf(AdminServiceError);
  });

  it('deletes a client and 404s on an unknown client', async () => {
    const admin = makeAdmin(state);
    const { clientId } = await admin.createClient({ applicationId: 'default-app', id: 'gone', name: 'tmp', grantTypes: ['password'] });
    const res = await admin.deleteClient(clientId);
    expect(res).toEqual({ clientId: 'gone', deleted: true });
    expect(state.OAuthClient._items.find((c) => c._id === 'gone')).toBeUndefined();
    await expect(admin.deleteClient('gone')).rejects.toMatchObject({ status: 404, code: 'client_not_found' });
  });

  it('creates a user and rejects a duplicate email', async () => {
    const admin = makeAdmin(state);
    const u = await admin.createUser({ email: 'A@Example.com', password: 'secret-pass' });
    expect(u.email).toBe('a@example.com'); // normalized
    await expect(admin.createUser({ email: 'a@example.com', password: 'x' }))
      .rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });

  it('links a federated identity onto a user, is idempotent, and lists it (RQ-0011)', async () => {
    const admin = makeAdmin(state);
    await admin.createUser({ email: 'op@acme.test', password: 'secret-pass' });

    const res = await admin.linkUserIdentity('op@acme.test', { provider: 'google', subject: 'g-1', emailVerified: true });
    expect(res).toMatchObject({ email: 'op@acme.test', provider: 'google', subject: 'g-1', linked: true });

    const user = state.User._items.find((u) => u.email === 'op@acme.test');
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0]).toMatchObject({ provider: 'google', subject: 'g-1', emailVerified: true });

    // Idempotent: linking the same identity again does not duplicate it.
    await admin.linkUserIdentity('op@acme.test', { provider: 'google', subject: 'g-1' });
    expect(user.identities).toHaveLength(1);

    // listUsers surfaces identities and never the password hash.
    const listed = (await admin.listUsers()).find((u: any) => u.email === 'op@acme.test');
    expect(listed.identities[0].subject).toBe('g-1');
  });

  it('refuses to link an identity already owned by another user', async () => {
    const admin = makeAdmin(state);
    await admin.createUser({ email: 'a@acme.test', password: 'p1' });
    await admin.createUser({ email: 'b@acme.test', password: 'p2' });
    await admin.linkUserIdentity('a@acme.test', { provider: 'google', subject: 'shared' });
    await expect(admin.linkUserIdentity('b@acme.test', { provider: 'google', subject: 'shared' }))
      .rejects.toMatchObject({ status: 409, code: 'identity_linked' });
  });

  it('unlinks a federated identity and 404s on an unknown user', async () => {
    const admin = makeAdmin(state);
    await admin.createUser({ email: 'op@acme.test', password: 'p' });
    await admin.linkUserIdentity('op@acme.test', { provider: 'google', subject: 'g-1' });
    const res = await admin.unlinkUserIdentity('op@acme.test', { provider: 'google', subject: 'g-1' });
    expect(res).toMatchObject({ unlinked: true });
    expect(state.User._items.find((u) => u.email === 'op@acme.test').identities).toHaveLength(0);
    await expect(admin.unlinkUserIdentity('nobody@acme.test', { provider: 'google', subject: 'g-1' }))
      .rejects.toMatchObject({ status: 404, code: 'user_not_found' });
  });

  it('reports stats in the console shape', async () => {
    const admin = makeAdmin(state);
    const stats = await admin.getStats();
    expect(stats).not.toHaveProperty('tenants');
    expect(stats.clients.total).toBe(0);
    expect(stats.keys.active).toBe(1);
    expect(stats).toHaveProperty('tokens.accessLastHour');
    // ADR-0020: the dashboard surfaces the application count.
    expect(stats.applications).toEqual({ total: 1 }); // the default application seeded in makeState
    // ADR-0019: the dashboard surfaces the count of active entitlements.
    expect(stats.assignments).toEqual({ active: 0 });
  });

  it('does not stamp roles onto a created user (roles are per-application now, ADR-0019)', async () => {
    const admin = makeAdmin(state);
    const u = await admin.createUser({ email: 'u@x.test', password: 'secret-pass' });
    expect(u).toEqual({ id: expect.any(String), email: 'u@x.test' });
    expect(state.User._items[0]).not.toHaveProperty('roles');
  });

  // --- Applications (ADR-0020): the product-level registration ---

  it('creates, lists, gets, and deletes an application', async () => {
    const admin = makeAdmin(state);
    const { applicationId } = await admin.createApplication({ id: 'coach', name: 'Coach', audience: 'coach-ws', roles: [{ key: 'member' }] });
    expect(applicationId).toBe('coach');

    const listed = (await admin.listApplications()) as any[];
    expect(listed.map((a: any) => a._id)).toContain('coach');

    const got = await admin.getApplication('coach');
    expect(got).toMatchObject({ _id: 'coach', name: 'Coach', audience: 'coach-ws' });
    await expect(admin.getApplication('ghost')).rejects.toMatchObject({ status: 404, code: 'application_not_found' });

    // Reusing an id is a conflict.
    await expect(admin.createApplication({ id: 'coach', name: 'dupe' }))
      .rejects.toMatchObject({ status: 409, code: 'application_exists' });

    const del = await admin.deleteApplication('coach');
    expect(del).toEqual({ applicationId: 'coach', deleted: true });
    expect(state.Application._items.find((a) => a._id === 'coach')).toBeUndefined();
    await expect(admin.deleteApplication('coach')).rejects.toMatchObject({ status: 404, code: 'application_not_found' });
  });

  it('refuses to delete an application that still has credentials', async () => {
    const admin = makeAdmin(state);
    await admin.createClient({ applicationId: 'default-app', name: 'svc', grantTypes: ['client_credentials'] });
    await expect(admin.deleteApplication('default-app'))
      .rejects.toMatchObject({ status: 409, code: 'application_has_credentials' });
  });

  it('reads and replaces an application role catalogue, validating each entry has a key (ADR-0020)', async () => {
    const admin = makeAdmin(state);
    const { applicationId } = await admin.createApplication({ id: 'app-cat', name: 'App', audience: 'app-ws', roles: [{ key: 'member' }] });
    expect(await admin.getApplicationRoles(applicationId)).toEqual([{ key: 'member', name: undefined, description: undefined }]);

    const updated = await admin.setApplicationRoles(applicationId, [{ key: 'admin', name: 'Admin' }, { key: 'member' }]);
    expect(updated.map((r) => r.key)).toEqual(['admin', 'member']);

    await expect(admin.setApplicationRoles(applicationId, [{ name: 'no key' } as any]))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    await expect(admin.getApplicationRoles('ghost')).rejects.toMatchObject({ status: 404, code: 'application_not_found' });
  });

  it('assigns a user to an app with catalogue-checked roles, lists both directions, updates and revokes', async () => {
    const admin = makeAdmin(state);
    const { applicationId } = await admin.createApplication({
      id: 'app-1', name: 'App One', audience: 'app-ws', roles: [{ key: 'member' }, { key: 'lead' }]
    });
    await admin.createUser({ email: 'u@x.test', password: 'secret-pass' });

    // A role outside the app's catalogue is rejected (ADR-0020).
    await expect(admin.assignUser({ email: 'u@x.test', applicationId, roles: ['ghost'] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_role' });

    const assigned = await admin.assignUser({ email: 'u@x.test', applicationId, roles: ['member'] });
    expect(assigned).toMatchObject({ email: 'u@x.test', applicationId, roles: ['member'], status: 'active' });
    expect(state.Assignment._items).toHaveLength(1);

    // Idempotent upsert: re-assigning updates the roles in place, never a second row.
    const reassigned = await admin.assignUser({ email: 'u@x.test', applicationId, roles: ['member', 'lead'] });
    expect(reassigned.roles).toEqual(['member', 'lead']);
    expect(state.Assignment._items).toHaveLength(1);

    // Both directions of the entitlement graph.
    const members = await admin.listApplicationMembers(applicationId);
    expect(members).toEqual([{ userId: expect.any(String), email: 'u@x.test', userStatus: 'active', status: 'active', roles: ['member', 'lead'] }]);
    const apps = await admin.listUserAssignments('u@x.test');
    expect(apps).toEqual([{ applicationId, applicationName: 'App One', status: 'active', roles: ['member', 'lead'] }]);

    // Suspend, then revoke — and updating a revoked assignment 404s.
    const suspended = await admin.updateAssignment('u@x.test', applicationId, { status: 'suspended' });
    expect(suspended.status).toBe('suspended');
    expect(await admin.revokeAssignment('u@x.test', applicationId)).toMatchObject({ email: 'u@x.test', applicationId, revoked: true });
    expect(state.Assignment._items).toHaveLength(0);
    await expect(admin.updateAssignment('u@x.test', applicationId, { status: 'active' }))
      .rejects.toMatchObject({ status: 404, code: 'assignment_not_found' });
    await expect(admin.revokeAssignment('u@x.test', applicationId))
      .rejects.toMatchObject({ status: 404, code: 'assignment_not_found' });
  });

  it('deleting an application cascades to its assignments', async () => {
    const admin = makeAdmin(state);
    await admin.createApplication({ id: 'app-cascade', name: 'Cascade', audience: 'cascade-ws', roles: [{ key: 'member' }] });
    await admin.createUser({ email: 'u@x.test', password: 'secret-pass' });
    await admin.assignUser({ email: 'u@x.test', applicationId: 'app-cascade', roles: ['member'] });
    expect(state.Assignment._items).toHaveLength(1);
    await admin.deleteApplication('app-cascade');
    expect(state.Assignment._items).toHaveLength(0);
  });

  it('refuses to assign a user against an unknown application', async () => {
    const admin = makeAdmin(state);
    await admin.createUser({ email: 'u@x.test', password: 'secret-pass' });
    await expect(admin.assignUser({ email: 'u@x.test', applicationId: 'ghost', roles: [] }))
      .rejects.toMatchObject({ status: 404, code: 'application_not_found' });
    await expect(admin.assignUser({ email: 'nobody@x.test', applicationId: 'ghost', roles: [] }))
      .rejects.toMatchObject({ status: 404, code: 'user_not_found' });
  });
});

describe('admin-auth (requireAdmin)', () => {
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
      .setIssuer(CONFIG.auth.jwtIssuer)
      .setAudience('identity-service-clients')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(createPrivateKeyForTest());

  function createPrivateKeyForTest() {
    // jose accepts a KeyObject; import the PEM via node crypto.
    const { createPrivateKey } = require('crypto');
    return createPrivateKey(testPrivateKeyPem);
  }

  const run = async (token: string | null, areaScope: string) => {
    const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    let statusCode = 200; let body: any = null; let nexted = false;
    const res: any = { status(c: number) { statusCode = c; return this; }, json(b: any) { body = b; return this; } };
    await requireAdmin(areaScope)(req, res, () => { nexted = true; });
    return { statusCode, body, nexted, req };
  };

  it('401s without a token', async () => {
    const { statusCode, nexted } = await run(null, ADMIN_SCOPES.users);
    expect(statusCode).toBe(401);
    expect(nexted).toBe(false);
  });

  it('allows a token with the superscope and attaches the principal', async () => {
    const token = await sign({ cid: 'admin-client', sub: 'svc', scope: 'admin' });
    const { nexted, req } = await run(token, ADMIN_SCOPES.users);
    expect(nexted).toBe(true);
    expect(req.admin.clientId).toBe('admin-client');
  });

  it('allows a token with the matching granular scope', async () => {
    const token = await sign({ cid: 'c', scope: 'admin:users other' });
    const { nexted } = await run(token, ADMIN_SCOPES.users);
    expect(nexted).toBe(true);
  });

  it('403s a valid token lacking the required scope', async () => {
    const token = await sign({ cid: 'c', scope: 'admin:keys' });
    const { statusCode, nexted } = await run(token, ADMIN_SCOPES.users);
    expect(statusCode).toBe(403);
    expect(nexted).toBe(false);
  });

  it('403s a user token (no cid) even with an admin scope but no operator role', async () => {
    const token = await sign({ sub: 'user@x.com', scope: 'admin' });
    const { statusCode, nexted } = await run(token, ADMIN_SCOPES.users);
    expect(statusCode).toBe(403);
    expect(nexted).toBe(false);
  });

  // ADR-0010: a user identity token whose `roles` claim carries a configured operator role is an
  // operator principal, mapped to the superscope and attributed per-actor by `sub`.
  it('allows a user token whose roles include an operator role and attaches an operator principal', async () => {
    const token = await sign({ sub: 'ada@fps4.nl', roles: ['platform_admin'] });
    const { nexted, req } = await run(token, ADMIN_SCOPES.keys);
    expect(nexted).toBe(true);
    expect(req.admin.kind).toBe('operator');
    expect(req.admin.subject).toBe('ada@fps4.nl');
    expect(req.admin.clientId).toBeUndefined();
  });

  it('403s a user token whose roles do not include an operator role', async () => {
    const token = await sign({ sub: 'member@x.com', roles: ['member'] });
    const { statusCode, nexted } = await run(token, ADMIN_SCOPES.users);
    expect(statusCode).toBe(403);
    expect(nexted).toBe(false);
  });
});
