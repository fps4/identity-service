import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { jwtVerify, importSPKI } from 'jose';
import { createOAuthServer } from '../src/oauth/server.js';
import { createUserService, UserServiceError } from '../src/services/users.js';
import { hashSecret } from '../src/utils/hash.js';
import { InvalidGrantError, UnauthorizedClientError, AccessDeniedError } from '../src/oauth/errors.js';
import { CONFIG } from '../src/config.js';

const { privateKey: signingPrivatePem, publicKey: signingPublicPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

vi.mock('../src/utils/key-store.js', () => ({
  getActiveKeyPair: vi.fn(async () => ({ kid: 'test-kid', privateKeyPem: signingPrivatePem, publicKeyPem: signingPublicPem })),
  ensureActiveSigningKey: vi.fn(async () => ({ kid: 'test-kid', privateKeyPem: signingPrivatePem, publicKeyPem: signingPublicPem })),
  listPublicKeys: vi.fn(async () => []),
  rotateSigningKey: vi.fn()
}));

import { Transaction, type Store } from '../src/db/index.js';
import { testStore, type TestStore } from './helpers/store.js';
import { fixtures } from './helpers/fixtures.js';

function makeDeps(store: Store, now: () => Date) {
  return { store, now, logger: { info: () => {}, error: () => {} } as any };
}

async function seedLocalClient(store: Store) {
  // The application (ADR-0020) owns the default audience + role catalogue; the credential just points at it.
  await fixtures.application(store, {
    _id: 'app-local', name: 'Local App', audience: 'maestro-workspace',
    roles: [{ key: 'tenant_admin' }, { key: 'member' }]
  });
  await fixtures.client(store, {
    _id: 'client-local', name: 'local web', applicationId: 'app-local',
    grantTypes: ['password'], redirectUris: [], scopes: [], isConfidential: false, secretHash: ''
  });
}

describe('Local password IdP — registration (RQ-0002)', () => {
  let db: TestStore;
  let store: Store;
  let users: ReturnType<typeof createUserService>;
  const now = () => new Date('2026-06-01T12:00:00.000Z');

  beforeEach(async () => {
    db = await testStore();
    store = db.store;
    await seedLocalClient(store);
    users = createUserService(makeDeps(store, now));
  });
  afterEach(() => db.drop());

  it('registers a user with a stable subject id', async () => {
    const user = await users.registerUser({ email: 'Reviewer@FPS4.test', password: 'correct-horse-battery' });
    expect(user.email).toBe('reviewer@fps4.test'); // normalized
    expect(user.id).toBeTruthy();
    expect(await store.users.count()).toBe(1);
    expect((await store.users.get(user.id))!.passwordHash).not.toContain('correct-horse'); // hashed, not raw
  });

  it('rejects a duplicate email (409)', async () => {
    await users.registerUser({ email: 'dup@fps4.test', password: 'correct-horse-battery' });
    await expect(users.registerUser({ email: 'dup@fps4.test', password: 'another-strong-pass' }))
      .rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });

  it('rejects a weak password (400)', async () => {
    await expect(users.registerUser({ email: 'weak@fps4.test', password: 'short' }))
      .rejects.toMatchObject({ status: 400, code: 'weak_password' });
  });

  it('rejects an invalid email (400)', async () => {
    await expect(users.registerUser({ email: 'not-an-email', password: 'correct-horse-battery' }))
      .rejects.toBeInstanceOf(UserServiceError);
  });

  it('refuses when the local IdP is disabled deployment-wide (AUTH_LOCAL_IDP_ENABLED)', async () => {
    const saved = CONFIG.auth.localIdpEnabled;
    (CONFIG.auth as any).localIdpEnabled = false;
    try {
      await expect(users.registerUser({ email: 'x@fps4.test', password: 'correct-horse-battery' }))
        .rejects.toMatchObject({ status: 400, code: 'local_idp_disabled' });
    } finally {
      (CONFIG.auth as any).localIdpEnabled = saved;
    }
  });
});

describe('Local password IdP — login (RQ-0002)', () => {
  let db: TestStore;
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const fixedNow = new Date('2026-06-01T12:00:00.000Z');
  const password = 'correct-horse-battery';
  const user = () => store.users.get('user-sub-1').then((u) => u!);

  beforeEach(async () => {
    db = await testStore();
    store = db.store;
    await seedLocalClient(store);
    await fixtures.user(store, {
      _id: 'user-sub-1', email: 'reviewer@fps4.test',
      passwordHash: hashSecret(password), status: 'active', failedAttempts: 0, lockedUntil: null
    });
    // ADR-0020: the token's roles are the app-scoped roles from the user's active assignment to the
    // application, not a field on the user. Seed the entitlement that gates issuance.
    await fixtures.assignment(store, { userId: 'user-sub-1', applicationId: 'app-local', roles: ['tenant_admin', 'member'], status: 'active' });
    server = createOAuthServer(makeDeps(store, () => fixedNow));
  });
  afterEach(() => db.drop());

  it('issues a user JWT (email + stable sub + aud) that passes maestro-style verification', async () => {
    const token = await server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' });
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    const { payload } = await jwtVerify(token.accessToken, publicKey, {
      issuer: CONFIG.auth.jwtIssuer, audience: 'maestro-workspace', requiredClaims: ['exp'], currentDate: fixedNow
    });
    expect(payload.email).toBe('reviewer@fps4.test');
    expect(payload.sub).toBe('user-sub-1');
    expect(payload.aud).toBe('maestro-workspace');
    expect(payload.roles).toEqual(['tenant_admin', 'member']); // app-scoped roles from the assignment
    expect(token.refreshToken).toBeTruthy();
  });

  it('omits the roles claim when the assignment grants no roles', async () => {
    await fixtures.assignment(store, { userId: 'user-sub-1', applicationId: 'app-local', roles: [], status: 'active' });
    const token = await server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' });
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    const { payload } = await jwtVerify(token.accessToken, publicKey, {
      issuer: CONFIG.auth.jwtIssuer, audience: 'maestro-workspace', requiredClaims: ['exp'], currentDate: fixedNow
    });
    expect(payload.roles).toBeUndefined();
  });

  it('rejects a wrong password and increments the failure counter', async () => {
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password: 'wrong', clientId: 'client-local' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
    expect((await user()).failedAttempts).toBe(1);
  });

  it('returns the same generic error for an unknown email (no user enumeration)', async () => {
    await expect(server.issuePasswordToken({ username: 'nobody@fps4.test', password, clientId: 'client-local' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('locks the account after the configured failures, then refuses even a correct password', async () => {
    await store.users.update('user-sub-1', { failedAttempts: CONFIG.auth.password.maxFailedAttempts - 1 });
    // The failing attempt that trips the lock.
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password: 'wrong', clientId: 'client-local' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
    expect((await user()).lockedUntil).toBeInstanceOf(Date);
    // Correct password is now refused while locked (the reason rides in the OAuth error description).
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' }))
      .rejects.toMatchObject({ error: 'invalid_grant', description: expect.stringMatching(/locked/i) });
  });

  it('refuses a disabled account', async () => {
    await store.users.update('user-sub-1', { status: 'disabled' });
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('refuses a client that does not allow the password grant', async () => {
    await store.clients.update('client-local', { grantTypes: ['authorization_code'] });
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' }))
      .rejects.toBeInstanceOf(UnauthorizedClientError);
  });

  // --- ADR-0019 entitlement gate: valid credentials are not enough without an active assignment ---

  it('denies a correctly-authenticated user who is not assigned to the application', async () => {
    // Authenticated, but no entitlement to this app.
    const tx = new Transaction();
    store.assignments.delete(tx, 'user-sub-1', 'app-local');
    await store.commit(tx);
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' }))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(await store.tokens.countIssuedSince('access', new Date(0))).toBe(0);
  });

  it('denies a user whose assignment to the application is suspended', async () => {
    await fixtures.assignment(store, { userId: 'user-sub-1', applicationId: 'app-local', roles: ['tenant_admin', 'member'], status: 'suspended' });
    await expect(server.issuePasswordToken({ username: 'reviewer@fps4.test', password, clientId: 'client-local' }))
      .rejects.toBeInstanceOf(AccessDeniedError);
    expect(await store.tokens.countIssuedSince('access', new Date(0))).toBe(0);
  });
});
