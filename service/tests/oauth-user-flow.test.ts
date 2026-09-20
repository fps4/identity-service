import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'crypto';
import { SignJWT, jwtVerify, importSPKI, importPKCS8 } from 'jose';
import { createOAuthServer } from '../src/oauth/server.js';
import { createGoogleIdp } from '../src/oauth/google.js';
import { InvalidRequestError, UnauthorizedClientError, InvalidGrantError, AccessDeniedError } from '../src/oauth/errors.js';
import { CONFIG } from '../src/config.js';
import type { OAuthServerDependencies } from '../src/oauth/types.js';
import type { GoogleIdp } from '../src/oauth/google.js';

// A single RSA key pair stands in for the service's active signing key throughout the suite.
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

// --- A table of the test's own on DynamoDB Local -----------------------------------------------

import { Transaction, type Store } from '../src/db/index.js';
import { testStore, type TestStore } from './helpers/store.js';
import { fixtures } from './helpers/fixtures.js';

// The user the stub IdP asserts. A federated login resolves the person by `(provider, subject)`; the
// happy path seeds them linked and entitled, as an operator (or an invite) would have.
const REVIEWER = { _id: 'u-reviewer', email: 'reviewer@fps4.test', sub: 'google-sub-123' };

async function seedReviewer(store: Store, roles: string[] = [], overrides: Record<string, any> = {}) {
  await fixtures.user(store, {
    _id: REVIEWER._id, email: REVIEWER.email, status: 'active',
    identities: [{ provider: 'google', subject: REVIEWER.sub, emailVerified: true, linkedAt: new Date(0) }],
    ...overrides
  });
  await seedAssignment(store, roles, { userId: REVIEWER._id });
}

// Seed a single active entitlement to the maestro application with the given app-scoped roles (ADR-0019).
function seedAssignment(store: Store, roles: string[] = [], overrides: { userId: string; status?: 'active' | 'suspended' }) {
  return fixtures.assignment(store, { applicationId: 'app-maestro', roles, status: 'active', ...overrides });
}

function makeDeps(store: Store, googleIdp: GoogleIdp, now: () => Date): OAuthServerDependencies {
  return { store, googleIdp, now, logger: { info: () => {}, error: () => {} } as any };
}

const countTokens = (store: Store) => store.tokens.countIssuedSince('access', new Date(0));
const stateOf = (redirectTo: string) => new URL(redirectTo).searchParams.get('state')!;
const codeOf = (redirectTo: string) => new URL(redirectTo).searchParams.get('code');

// --- A stub Google IdP: deterministic, no network ---------------------------------------------

function makeStubIdp(overrides: Partial<GoogleIdp> = {}): GoogleIdp {
  return {
    buildAuthorizationUrl: ({ state, nonce }) => `https://accounts.google.test/auth?state=${state}&nonce=${nonce}`,
    exchangeCode: async () => ({ idToken: 'stub-id-token' }),
    verifyIdToken: async () => ({ email: 'reviewer@fps4.test', sub: 'google-sub-123', emailVerified: true }),
    ...overrides
  };
}

const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

async function seedClient(store: Store) {
  // The application (ADR-0020) owns the default audience; the credential just points at it.
  await fixtures.application(store, {
    _id: 'app-maestro',
    name: 'Maestro',
    audience: 'maestro-workspace',
    roles: []
  });
  await fixtures.client(store, {
    _id: 'client-maestro',
    name: 'maestro web',
    applicationId: 'app-maestro',
    secretHash: 'unused',
    grantTypes: ['authorization_code'],
    redirectUris: ['https://maestro.test/callback'],
    scopes: [],
    isConfidential: false
  });
}

// Drive authorize -> callback -> token and return the issued token response. The browser's leg is read
// from the redirects, as the consumer would: the Google `state` from the first, our `code` from the second.
async function runHappyPath(server: ReturnType<typeof createOAuthServer>, verifier: string) {
  const started = await server.startAuthorization({
    clientId: 'client-maestro',
    redirectUri: 'https://maestro.test/callback',
    codeChallenge: pkceChallenge(verifier),
    state: 'consumer-state-xyz'
  });
  if (started.mode !== 'redirect') throw new Error('expected the Google leg');
  const back = await server.handleGoogleCallback({ code: 'google-code', state: stateOf(started.redirectTo) });
  const code = codeOf(back.redirectTo) as string; // capture before it is consumed
  const token = await server.issueAuthorizationCodeToken({
    code,
    codeVerifier: verifier,
    clientId: 'client-maestro',
    redirectUri: 'https://maestro.test/callback'
  });
  return { token, code };
}

describe('OAuth server – Google SSO user flow (RQ-0001)', () => {
  let db: TestStore;
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const fixedNow = new Date('2026-06-01T12:00:00.000Z');
  const verifier = 'test-code-verifier-0123456789-abcdefghijklmnop';

  beforeEach(async () => {
    db = await testStore();
    store = db.store;
    await seedClient(store);
    await seedReviewer(store); // linked and entitled, so the happy path can issue a token (ADR-0019)
    server = createOAuthServer(makeDeps(store, makeStubIdp(), () => fixedNow));
  });
  afterEach(() => db.drop());

  it('issues a user JWT that passes maestro-style verification (email, sub, iss, aud, exp via JWKS)', async () => {
    const { token } = await runHappyPath(server, verifier);

    expect(token.tokenType).toBe('Bearer');
    expect(token.expiresIn).toBe(CONFIG.oauth.accessTokenTtlSec);
    expect(token.refreshToken).toBeTruthy();

    // Verify exactly as a consumer's authenticated edge does: RS256 via the published key, iss + aud + exp enforced.
    // `currentDate` pins jose's clock to the issuance time (the suite issues at a fixed `now`).
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    const { payload } = await jwtVerify(token.accessToken, publicKey, {
      issuer: CONFIG.auth.jwtIssuer,
      audience: 'maestro-workspace',
      requiredClaims: ['exp'],
      currentDate: fixedNow
    });
    expect(payload.email).toBe('reviewer@fps4.test');
    expect(payload.sub).toBe('google-sub-123'); // the stable Google subject, not the email
    expect(payload.aud).toBe('maestro-workspace');
    expect(payload.iss).toBe(CONFIG.auth.jwtIssuer);
    expect(typeof payload.exp).toBe('number');
  });

  it('binds aud to the initiating client (a token is not valid for another workspace)', async () => {
    const { token } = await runHappyPath(server, verifier);
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    await expect(
      jwtVerify(token.accessToken, publicKey, { audience: 'some-other-workspace', currentDate: fixedNow })
    ).rejects.toThrow();
  });

  it('persists an active session and a hashed refresh token', async () => {
    const { token } = await runHappyPath(server, verifier);
    const { sha256Hex } = await import('../src/utils/hash.js');
    const refresh = (await store.tokens.getRefreshByHash(sha256Hex(token.refreshToken)))!;
    expect(refresh).toMatchObject({ type: 'refresh', status: 'active', clientId: 'client-maestro', subject: REVIEWER.sub });
    expect(refresh.hashedToken).toBeTruthy();
    expect(refresh.hashedToken).not.toBe(token.refreshToken); // hashed, never the raw value
    const session = (await store.sessions.get(refresh.sessionId!))!;
    expect(session.status).toBe('active');
    expect(session.expiresAt).toEqual(refresh.expiresAt); // the refresh token never outlives the session
    expect(await store.tokens.countActiveRefresh()).toBe(1);
  });

  it('rejects an unregistered redirect_uri at authorize time', async () => {
    await expect(server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://evil.test/callback',
      codeChallenge: pkceChallenge(verifier)
    })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('rejects an application without an audience configured', async () => {
    await store.applications.update('app-maestro', { audience: undefined });
    await expect(server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback',
      codeChallenge: pkceChallenge(verifier)
    })).rejects.toBeInstanceOf(UnauthorizedClientError);
  });

  it('denies the callback on an unknown/invalid state', async () => {
    await expect(server.handleGoogleCallback({ code: 'x', state: 'never-issued' }))
      .rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('redirects back with an OAuth error (and mints no token) when the Google id_token is rejected', async () => {
    const failingIdp = makeStubIdp({
      verifyIdToken: async () => { throw new AccessDeniedError('expired Google id_token'); }
    });
    server = createOAuthServer(makeDeps(store, failingIdp, () => fixedNow));

    const started = await server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback',
      codeChallenge: pkceChallenge(verifier),
      state: 'consumer-state'
    });
    const state = stateOf((started as { redirectTo: string }).redirectTo);
    const result = await server.handleGoogleCallback({ code: 'google-code', state });

    expect(result.redirectTo).toContain('error=access_denied');
    expect((await store.authorizations.getByState(state))!.code).toBeUndefined(); // no auth code minted
    expect(await countTokens(store)).toBe(0);                                       // no token issued
  });

  it('rejects the token exchange when the PKCE verifier is wrong', async () => {
    const started = await server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback',
      codeChallenge: pkceChallenge(verifier),
      state: 's'
    });
    const back = await server.handleGoogleCallback({ code: 'google-code', state: stateOf((started as { redirectTo: string }).redirectTo) });

    await expect(server.issueAuthorizationCodeToken({
      code: codeOf(back.redirectTo)!,
      codeVerifier: 'the-wrong-verifier',
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback'
    })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('makes the authorization code single-use', async () => {
    const { code } = await runHappyPath(server, verifier);
    // Replaying the same (now consumed) code must not mint a second token.
    await expect(server.issueAuthorizationCodeToken({
      code,
      codeVerifier: verifier,
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback'
    })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const { token: first } = await runHappyPath(server, verifier);
    const rotated = await server.refreshUserToken({ refreshToken: first.refreshToken, clientId: 'client-maestro' });

    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.accessToken).toBeTruthy();

    // The original refresh token is now revoked.
    await expect(server.refreshUserToken({ refreshToken: first.refreshToken, clientId: 'client-maestro' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('refresh cannot outlive a revoked session (AC6)', async () => {
    const { token } = await runHappyPath(server, verifier);
    // Revoke the session directly — simulating an admin/logout revocation.
    const { sha256Hex } = await import('../src/utils/hash.js');
    const refresh = (await store.tokens.getRefreshByHash(sha256Hex(token.refreshToken)))!;
    await store.sessions.update(refresh.sessionId!, { status: 'revoked' });
    await expect(server.refreshUserToken({ refreshToken: token.refreshToken, clientId: 'client-maestro' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('revoking a refresh token cascades to its session', async () => {
    const { token } = await runHappyPath(server, verifier);
    const { sha256Hex } = await import('../src/utils/hash.js');
    const refresh = (await store.tokens.getRefreshByHash(sha256Hex(token.refreshToken)))!;
    await server.revokeUserToken({ token: token.refreshToken });
    expect((await store.sessions.get(refresh.sessionId!))!.status).toBe('revoked');
    expect((await store.tokens.get(refresh._id))!.status).toBe('revoked');
    await expect(server.refreshUserToken({ refreshToken: token.refreshToken, clientId: 'client-maestro' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });

  // --- ADR-0019 entitlement gate on the authorization-code + refresh grants ---

  it('denies the token exchange for a user with no active assignment to the application', async () => {
    // Authenticated by Google, but not entitled to this app.
    const tx = new Transaction();
    store.assignments.delete(tx, REVIEWER._id, 'app-maestro');
    await store.commit(tx);
    await expect(runHappyPath(server, verifier)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await countTokens(store)).toBe(0);
  });

  it('kills refresh once the application assignment is revoked mid-session (ADR-0019)', async () => {
    const { token } = await runHappyPath(server, verifier);
    // An operator revoked the entitlement after login.
    const tx = new Transaction();
    store.assignments.delete(tx, REVIEWER._id, 'app-maestro');
    await store.commit(tx);
    await expect(server.refreshUserToken({ refreshToken: token.refreshToken, clientId: 'client-maestro' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });
});

// --- Federated user identity: provisioning, roles/status, linking (RQ-0011) -------------------

describe('OAuth server – federated user identity (RQ-0011)', () => {
  let db: TestStore;
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const fixedNow = new Date('2026-06-01T12:00:00.000Z');
  const verifier = 'test-code-verifier-0123456789-abcdefghijklmnop';

  const build = (idp: GoogleIdp) => {
    server = createOAuthServer(makeDeps(store, idp, () => fixedNow));
  };

  // Drive authorize -> callback and return the minted single-use code (token exchange left to the test).
  async function runToCode(): Promise<string> {
    const started = await server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback',
      codeChallenge: pkceChallenge(verifier),
      state: 's'
    });
    const back = await server.handleGoogleCallback({ code: 'google-code', state: stateOf((started as { redirectTo: string }).redirectTo) });
    return codeOf(back.redirectTo) as string;
  }

  const exchange = (code: string) => server.issueAuthorizationCodeToken({
    code, codeVerifier: verifier, clientId: 'client-maestro', redirectUri: 'https://maestro.test/callback'
  });

  async function rolesInToken(accessToken: string): Promise<unknown> {
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    const { payload } = await jwtVerify(accessToken, publicKey, { currentDate: fixedNow });
    return payload.roles;
  }

  beforeEach(async () => {
    db = await testStore();
    store = db.store;
    await seedClient(store);
    build(makeStubIdp()); // verified email by default
  });
  afterEach(() => db.drop());

  it('JIT-provisions a federated user on first Google login (keyed by google sub, no password); the gate then wants an assignment', async () => {
    // A first sighting is provisioned, and refused a token until an operator assigns them (ADR-0019).
    await expect(exchange(await runToCode())).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await store.users.count()).toBe(1);
    const user = (await store.users.getByIdentity('google', 'google-sub-123'))!;
    expect(user.email).toBe('reviewer@fps4.test');
    expect(user.passwordHash).toBeUndefined();
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0]).toMatchObject({ provider: 'google', subject: 'google-sub-123', emailVerified: true });
    expect(user.identities[0].linkedAt).toEqual(fixedNow);
    expect(user.lastLoginAt).toEqual(fixedNow);
    expect(await store.users.getByEmail('reviewer@fps4.test')).toMatchObject({ _id: user._id });
    // Assigned, the next login issues the token.
    await seedAssignment(store, ['member'], { userId: user._id });
    const token = await exchange(await runToCode());
    expect(await rolesInToken(token.accessToken)).toEqual(['member']);
  });

  it('a second login for the same identity does not create a duplicate user', async () => {
    await exchange(await runToCode()).catch(() => {});
    await exchange(await runToCode()).catch(() => {});
    expect(await store.users.count()).toBe(1);
  });

  it('stamps the app-scoped assignment roles into the token (RQ-0005 now works for Google users)', async () => {
    // Pre-seed the same federated identity, entitled to the app with an app-scoped role.
    await fixtures.user(store, {
      _id: 'u-existing', email: 'reviewer@fps4.test', status: 'active',
      identities: [{ provider: 'google', subject: 'google-sub-123', emailVerified: true, linkedAt: new Date(0) }]
    });
    await seedAssignment(store, ['workspace_admin'], { userId: 'u-existing' });
    const token = await exchange(await runToCode());
    expect(await rolesInToken(token.accessToken)).toEqual(['workspace_admin']);
    expect(await store.users.count()).toBe(1); // matched the existing identity, no new row
  });

  it('denies a disabled user on the Google path (closing the status bypass)', async () => {
    await fixtures.user(store, {
      _id: 'u-disabled', email: 'reviewer@fps4.test', status: 'disabled',
      identities: [{ provider: 'google', subject: 'google-sub-123', emailVerified: true, linkedAt: new Date(0) }]
    });
    const code = await runToCode();
    await expect(exchange(code)).rejects.toBeInstanceOf(InvalidGrantError);
    expect(await countTokens(store)).toBe(0);
  });

  it('links the identity onto an existing account when the email is verified and matches', async () => {
    // A local password user already exists with this email, entitled to the app.
    await fixtures.user(store, {
      _id: 'local-1', email: 'reviewer@fps4.test', passwordHash: 'scrypt$...',
      status: 'active', identities: []
    });
    await seedAssignment(store, ['member'], { userId: 'local-1' });
    const token = await exchange(await runToCode());
    expect(await store.users.count()).toBe(1);           // linked, not duplicated
    const user = (await store.users.get('local-1'))!;
    expect(user.identities).toHaveLength(1);
    expect(user.identities[0]).toMatchObject({ provider: 'google', subject: 'google-sub-123' });
    expect(await store.users.getByIdentity('google', 'google-sub-123')).toMatchObject({ _id: 'local-1' });
    // Token sub is still the Google subject (contract unchanged), roles come from the assignment.
    const publicKey = await importSPKI(signingPublicPem, 'RS256');
    const { payload } = await jwtVerify(token.accessToken, publicKey, { currentDate: fixedNow });
    expect(payload.sub).toBe('google-sub-123');
    expect(payload.roles).toEqual(['member']);
  });

  it('refuses to merge onto an existing account when the Google email is unverified', async () => {
    build(makeStubIdp({ verifyIdToken: async () => ({ email: 'reviewer@fps4.test', sub: 'google-sub-123', emailVerified: false }) }));
    await fixtures.user(store, {
      _id: 'local-1', email: 'reviewer@fps4.test', passwordHash: 'scrypt$...',
      status: 'active', identities: []
    });
    const code = await runToCode();
    await expect(exchange(code)).rejects.toBeInstanceOf(AccessDeniedError);
    expect((await store.users.get('local-1'))!.identities).toHaveLength(0);   // no link
    expect(await countTokens(store)).toBe(0);                                  // no token
  });

  it('is idempotent under the concurrent-first-login race (the identity\'s unique item rejects the second insert)', async () => {
    // Simulate: another login for the same identity commits between this one's reads and its commit; the
    // identity is claimed, this commit fails its condition, and the person is re-read — the winner.
    const raced = {
      _id: 'u-raced', email: 'reviewer@fps4.test', status: 'active' as const,
      identities: [{ provider: 'google' as const, subject: 'google-sub-123', emailVerified: true, linkedAt: new Date(0) }]
    };
    const original = store.commit;
    store.commit = async (tx: Transaction) => {
      store.commit = original;
      await fixtures.user(store, raced);
      await seedAssignment(store, ['fast'], { userId: 'u-raced' }); // the winner's entitlement carries the app-scoped role
      return original(tx);
    };

    const token = await exchange(await runToCode());
    expect(await store.users.count()).toBe(1);
    expect(await rolesInToken(token.accessToken)).toEqual(['fast']); // re-read the winner
  });

  it('a federated-only user (no password) cannot use the password grant', async () => {
    await store.clients.update('client-maestro', { grantTypes: ['authorization_code', 'password'] });
    await fixtures.user(store, {
      _id: 'u-fed', email: 'fed@fps4.test', status: 'active',
      identities: [{ provider: 'google', subject: 'google-sub-999', emailVerified: true, linkedAt: new Date(0) }]
    });
    await expect(server.issuePasswordToken({ username: 'fed@fps4.test', password: 'anything', clientId: 'client-maestro' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
  });
});

// --- Registration policy gates federated JIT provisioning (RQ-0013, ADR-0013) -----------------

describe('OAuth server – invite-only deployments gate federated sign-up (RQ-0013)', () => {
  let db: TestStore;
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  let savedMode: 'open' | 'invite' | 'closed';
  const fixedNow = new Date('2026-06-01T12:00:00.000Z');
  const verifier = 'test-code-verifier-0123456789-abcdefghijklmnop';

  const startAndCallback = async () => {
    const started = await server.startAuthorization({
      clientId: 'client-maestro',
      redirectUri: 'https://maestro.test/callback',
      codeChallenge: pkceChallenge(verifier),
      state: 's'
    });
    const state = stateOf((started as { redirectTo: string }).redirectTo);
    const result = await server.handleGoogleCallback({ code: 'google-code', state });
    const authRecord = (await store.authorizations.getByState(state))!;
    return { authRecord, result };
  };

  const exchange = (code: string) => server.issueAuthorizationCodeToken({
    code, codeVerifier: verifier, clientId: 'client-maestro', redirectUri: 'https://maestro.test/callback'
  });

  // Registration policy is deployment config now (AUTH_REGISTRATION_MODE), not a tenant field.
  beforeEach(async () => {
    savedMode = CONFIG.auth.registrationMode;
    (CONFIG.auth as any).registrationMode = 'invite';
    db = await testStore();
    store = db.store;
    await seedClient(store);
    server = createOAuthServer(makeDeps(store, makeStubIdp(), () => fixedNow));
  });
  afterEach(async () => { (CONFIG.auth as any).registrationMode = savedMode; await db.drop(); });

  it('redirects a NEW Google identity back with access_denied at the callback (no code, no user)', async () => {
    const { authRecord, result } = await startAndCallback();
    expect(result.redirectTo).toContain('error=access_denied');
    expect(authRecord.code).toBeUndefined();
    expect(await store.users.count()).toBe(0);
    expect(await countTokens(store)).toBe(0);
  });

  it('lets an EXISTING linked user log in unchanged on an invite-only deployment', async () => {
    await fixtures.user(store, {
      _id: 'u-existing', email: 'reviewer@fps4.test', status: 'active',
      identities: [{ provider: 'google', subject: 'google-sub-123', emailVerified: true, linkedAt: new Date(0) }]
    });
    await seedAssignment(store, [], { userId: 'u-existing' }); // entitled to the app (ADR-0019)
    const { authRecord } = await startAndCallback();
    const token = await exchange(authRecord.code as string);
    expect(token.accessToken).toBeTruthy();
    expect(await store.users.count()).toBe(1);
  });

  it('still links Google onto an existing local account via verified email (the invitee path)', async () => {
    // The invitee registered locally with their code; first Google login must link, not be denied.
    await fixtures.user(store, {
      _id: 'local-1', email: 'reviewer@fps4.test', passwordHash: 'scrypt$...',
      status: 'active', identities: []
    });
    await seedAssignment(store, [], { userId: 'local-1' });
    const { authRecord } = await startAndCallback();
    await exchange(authRecord.code as string);
    const linked = (await store.users.get('local-1'))!;
    expect(linked.identities).toHaveLength(1);
    expect(linked.identities[0]).toMatchObject({ provider: 'google', subject: 'google-sub-123' });
  });

  it('the token exchange re-enforces the gate even if the policy flips mid-flow (authoritative check)', async () => {
    (CONFIG.auth as any).registrationMode = 'open';       // callback preflight passes...
    const { authRecord } = await startAndCallback();
    (CONFIG.auth as any).registrationMode = 'closed';     // ...but the deployment closes before the exchange
    await expect(exchange(authRecord.code as string)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await store.users.count()).toBe(0);
    expect(await countTokens(store)).toBe(0);
  });

  it('a closed deployment behaves like invite for a new federated identity', async () => {
    (CONFIG.auth as any).registrationMode = 'closed';
    const { result } = await startAndCallback();
    expect(result.redirectTo).toContain('error=access_denied');
    expect(await store.users.count()).toBe(0);
  });
});

// --- The real Google id_token verifier (signature / iss / aud / exp / nonce) ------------------

describe('createGoogleIdp.verifyIdToken', () => {
  const { privateKey: gPriv, publicKey: gPub } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const googleConfig = {
    clientId: 'google-client-id',
    clientSecret: 'google-secret',
    issuer: 'https://accounts.google.test',
    authorizationEndpoint: 'https://accounts.google.test/auth',
    tokenEndpoint: 'https://accounts.google.test/token',
    jwksUri: 'https://accounts.google.test/certs',
    redirectUri: 'https://auth.test/oauth2/callback'
  };

  async function makeIdp() {
    const keyResolver = await importSPKI(gPub, 'RS256');
    return createGoogleIdp(googleConfig, { keyResolver });
  }

  async function signGoogleIdToken(claims: Record<string, unknown>, expSecondsFromNow = 300) {
    const key = await importPKCS8(gPriv, 'RS256');
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'g-kid', typ: 'JWT' })
      .setIssuer(googleConfig.issuer)
      .setAudience(googleConfig.clientId)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + expSecondsFromNow)
      .sign(key);
  }

  it('accepts a valid id_token and returns the identity', async () => {
    const idp = await makeIdp();
    const token = await signGoogleIdToken({ email: 'u@x.test', email_verified: true, sub: 'g-sub-1', nonce: 'N1' });
    const identity = await idp.verifyIdToken(token, { nonce: 'N1' });
    expect(identity).toEqual({ email: 'u@x.test', sub: 'g-sub-1', emailVerified: true });
  });

  it('rejects an expired id_token', async () => {
    const idp = await makeIdp();
    const token = await signGoogleIdToken({ email: 'u@x.test', sub: 'g-sub-1', nonce: 'N1' }, -10);
    await expect(idp.verifyIdToken(token, { nonce: 'N1' })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('rejects a nonce mismatch', async () => {
    const idp = await makeIdp();
    const token = await signGoogleIdToken({ email: 'u@x.test', sub: 'g-sub-1', nonce: 'N1' });
    await expect(idp.verifyIdToken(token, { nonce: 'DIFFERENT' })).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('rejects a token minted for a different audience', async () => {
    const idp = await makeIdp();
    const key = await importPKCS8(gPriv, 'RS256');
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: 'u@x.test', sub: 'g-sub-1', nonce: 'N1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'g-kid', typ: 'JWT' })
      .setIssuer(googleConfig.issuer)
      .setAudience('some-other-client')
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(key);
    await expect(idp.verifyIdToken(token, { nonce: 'N1' })).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
