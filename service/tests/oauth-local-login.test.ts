/**
 * The first-party interactive login (RQ-0002 over the authorization-code flow) and RFC 8707
 * audience-binding for user tokens (ADR-0009 Phase 2).
 *
 * These two features exist so a standard MCP client can reach the management MCP resource over HTTP:
 * without a local login leg, a deployment with no Google app cannot serve the browser flow at all;
 * without audience-binding, the token it ends up with names the application's audience and the MCP
 * resource server rejects it. The suite drives both, plus the failure modes that keep them safe.
 *
 * NOTE: no `googleIdp` is injected and no GOOGLE_* env is set, so the server takes the local IdP path —
 * this is exactly the ds1 configuration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'crypto';
import { decodeJwt } from 'jose';
import { createOAuthServer } from '../src/oauth/server.js';
import { hashSecret } from '../src/utils/hash.js';
import {
  InvalidRequestError,
  InvalidGrantError,
  InvalidTargetError,
  AccessDeniedError
} from '../src/oauth/errors.js';
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

// --- A minimal in-memory mongoose-ish model layer ---------------------------------------------

const attachSave = <T extends object>(doc: T): T & { save: () => Promise<void> } => {
  if (typeof (doc as any).save !== 'function') {
    Object.defineProperty(doc, 'save', { value: async () => {}, enumerable: false, configurable: true });
  }
  return doc as any;
};

const matches = (item: any, query: any): boolean =>
  Object.entries(query).every(([key, value]) => item[key] === value);

// `resolveUserBySubject` (used by the refresh grant) queries with `$or` over `_id` and the linked
// identities, which the flat matcher above cannot express — so the User mock gets its own.
function userMatches(u: any, query: any): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return (value as any[]).some((sub) => userMatches(u, sub));
    if (key === 'identities.subject') return (u.identities ?? []).some((i: any) => i.subject === value);
    return u[key] === value;
  });
}

interface Store {
  clients: any[];
  applications: any[];
  authorizations: any[];
  tokens: any[];
  sessions: any[];
  users: any[];
  assignments: any[];
}

const makeStore = (): Store => ({
  clients: [], applications: [], authorizations: [], tokens: [], sessions: [], users: [], assignments: []
});

const assignmentMatches = (a: any, q: any): boolean =>
  a.applicationId === q.applicationId && a.status === q.status && (a.userId === undefined || a.userId === q.userId);

function makeDeps(store: Store, now: () => Date) {
  return {
    getMasterConnection: async () => ({}) as any,
    now,
    makeModels: () => ({
      OAuthClient: { findById: (id: string) => ({ lean: () => ({ exec: async () => store.clients.find((c) => c._id === id) ?? null }) }) },
      Application: { findById: (id: string) => ({ lean: () => ({ exec: async () => store.applications.find((a) => a._id === id) ?? null }) }) },
      OAuthAuthorization: {
        create: async (doc: any) => { store.authorizations.push(doc); return doc; },
        findOne: (q: any) => ({ exec: async () => { const a = store.authorizations.find((x) => matches(x, q)); return a ? attachSave(a) : null; } })
      },
      OAuthToken: {
        create: async (doc: any) => { store.tokens.push(doc); return doc; },
        findOne: (q: any) => ({ exec: async () => { const t = store.tokens.find((x) => matches(x, q)); return t ? attachSave(t) : null; } })
      },
      Session: {
        create: async (doc: any) => { store.sessions.push(doc); return doc; },
        findById: (id: string) => ({ exec: async () => { const s = store.sessions.find((x) => x._id === id); return s ? attachSave(s) : null; } })
      },
      User: {
        findOne: (q: any) => ({
          exec: async () => { const u = store.users.find((x) => userMatches(x, q)); return u ? attachSave(u) : null; },
          lean: () => ({ exec: async () => store.users.find((x) => userMatches(x, q)) ?? null })
        }),
        create: async (doc: any) => { store.users.push(doc); return attachSave(doc); }
      },
      Assignment: {
        findOne: (q: any) => ({ lean: () => ({ exec: async () => store.assignments.find((a) => assignmentMatches(a, q)) ?? null }) })
      },
      KeyStore: {} as any
    }) as any,
    logger: { info: () => {}, error: () => {} } as any
  };
}

const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const PASSWORD = 'correct-horse-battery-staple';

function seedClient(store: Store) {
  store.applications.push({ _id: 'app-admin', name: 'Admin', audience: 'identity-console', roles: [] });
  store.clients.push({
    _id: 'client-mcp',
    name: 'MCP client',
    applicationId: 'app-admin',
    secretHash: '',
    grantTypes: ['authorization_code'],
    redirectUris: ['http://localhost:9876/callback'],
    scopes: [],
    isConfidential: false
  });
  store.users.push({
    _id: 'user-1',
    email: 'operator@fps4.test',
    emailVerified: true,
    status: 'active',
    passwordHash: hashSecret(PASSWORD),
    failedAttempts: 0,
    lockedUntil: null
  });
  store.assignments.push({ _id: 'assign-1', applicationId: 'app-admin', userId: 'user-1', roles: ['platform_admin'], status: 'active' });
}

const authorizeArgs = (verifier: string, extra: Record<string, unknown> = {}) => ({
  clientId: 'client-mcp',
  redirectUri: 'http://localhost:9876/callback',
  codeChallenge: pkceChallenge(verifier),
  state: 'consumer-state-xyz',
  ...extra
});

describe('First-party interactive login (RQ-0002 over authorization_code)', () => {
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const now = () => new Date('2026-08-02T12:00:00.000Z');

  beforeEach(() => {
    store = makeStore();
    seedClient(store);
    server = createOAuthServer(makeDeps(store, now) as any);
  });

  it('serves a login form instead of an upstream redirect when no Google app is configured', async () => {
    const result = await server.startAuthorization(authorizeArgs('verifier-abc-123'));

    expect(result.mode).toBe('login');
    expect(result.mode === 'login' && result.loginToken).toBeTruthy();
    expect(store.authorizations[0].idp).toBe('local');
  });

  it('refuses the browser leg when the local IdP is disabled and there is no Google app', async () => {
    CONFIG.auth.localIdpEnabled = false;
    try {
      await expect(server.startAuthorization(authorizeArgs('verifier-abc-123')))
        .rejects.toBeInstanceOf(InvalidRequestError);
    } finally {
      CONFIG.auth.localIdpEnabled = true;
    }
  });

  it('authenticates valid credentials and redirects back to the consumer with a code', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';

    const { redirectTo } = await server.completeLocalLogin({
      loginToken, email: 'operator@fps4.test', password: PASSWORD
    });

    const url = new URL(redirectTo);
    expect(url.origin + url.pathname).toBe('http://localhost:9876/callback');
    expect(url.searchParams.get('state')).toBe('consumer-state-xyz');
    expect(url.searchParams.get('code')).toBeTruthy();

    const record = store.authorizations[0];
    expect(record.status).toBe('authenticated');
    expect(record.sub).toBe('user-1'); // a local login's subject IS the user record id
    expect(record.loginToken).toBeUndefined(); // single-use
  });

  it('normalizes the submitted email, so case and padding do not block a login', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';

    await expect(server.completeLocalLogin({
      loginToken, email: '  Operator@FPS4.test  ', password: PASSWORD
    })).resolves.toBeTruthy();
  });

  it('rejects a wrong password and counts it toward the brute-force lockout', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';

    await expect(server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: 'wrong' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
    expect(store.users[0].failedAttempts).toBe(1);
  });

  it('fails an unknown email identically to a wrong password (no user enumeration)', async () => {
    const attempt = async (email: string, password: string) => {
      const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
      const loginToken = started.mode === 'login' ? started.loginToken : '';
      return server.completeLocalLogin({ loginToken, email, password }).catch((e) => e);
    };

    const unknownEmail = await attempt('nobody@fps4.test', PASSWORD);
    const wrongPassword = await attempt('operator@fps4.test', 'wrong');

    // Same class, same status, same wording — nothing distinguishes "no such account" from "bad password".
    expect(unknownEmail).toBeInstanceOf(InvalidGrantError);
    expect(wrongPassword).toBeInstanceOf(InvalidGrantError);
    expect(unknownEmail.description).toBe(wrongPassword.description);
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.description).toBe('Invalid credentials');
  });

  it('leaves the authorization usable after a failed attempt, so the person can retry', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';

    await expect(server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: 'wrong' }))
      .rejects.toBeInstanceOf(InvalidGrantError);
    await expect(server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD }))
      .resolves.toBeTruthy();
  });

  it('burns the login token, so a replay cannot mint a second code', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';

    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });
    await expect(server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD }))
      .rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses an unknown login token', async () => {
    await expect(server.completeLocalLogin({ loginToken: 'not-a-real-token', email: 'operator@fps4.test', password: PASSWORD }))
      .rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses an expired authorization', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    store.authorizations[0].expiresAt = new Date('2026-08-02T11:00:00.000Z'); // before `now`

    await expect(server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD }))
      .rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('exchanges the code for a user token carrying the assignment roles', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    const token = await server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback'
    });

    const claims = decodeJwt(token.accessToken);
    expect(claims.sub).toBe('user-1');
    expect(claims.email).toBe('operator@fps4.test');
    expect(claims.roles).toEqual(['platform_admin']); // maps to the `admin` superscope in admin-auth
    expect(claims.aud).toBe('identity-console'); // no resource named → application default
  });

  it('denies the exchange for an account disabled between login and exchange', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    store.users[0].status = 'disabled';

    await expect(server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback'
    })).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('does not JIT-provision a user for a local login', async () => {
    const started = await server.startAuthorization(authorizeArgs('verifier-abc-123'));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    expect(store.users).toHaveLength(1);
    expect(store.users[0].identities).toBeUndefined(); // no federated identity was linked
  });
});

describe('Audience-binding via RFC 8707 resource indicator (ADR-0009 Phase 2)', () => {
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const now = () => new Date('2026-08-02T12:00:00.000Z');
  const RESOURCE = CONFIG.mcp.resourceUrl;

  beforeEach(() => {
    store = makeStore();
    seedClient(store);
    server = createOAuthServer(makeDeps(store, now) as any);
  });

  it('binds the issued token to the requested MCP resource instead of the application audience', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier, { resource: RESOURCE }));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    const token = await server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback',
      resource: RESOURCE
    });

    expect(decodeJwt(token.accessToken).aud).toBe(RESOURCE);
  });

  /**
   * Regression: audience-binding has to survive token ROTATION, not just the first issue. A refresh that
   * re-resolves the audience from the application hands back a token the resource server must reject —
   * and because it only bites at the first expiry, the login and the first calls all look correct. That
   * is precisely how it presented: a working MCP connection that died ~15 minutes later.
   */
  it('keeps the resource audience across a refresh', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier, { resource: RESOURCE }));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    const first = await server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback',
      resource: RESOURCE
    });
    expect(decodeJwt(first.accessToken).aud).toBe(RESOURCE);

    const refreshed = await server.refreshUserToken({ refreshToken: first.refreshToken, clientId: 'client-mcp' });

    expect(decodeJwt(refreshed.accessToken).aud).toBe(RESOURCE); // not the application default
  });

  it('keeps the binding across repeated refreshes, so a long session does not drift', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier, { resource: RESOURCE }));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    let token = await server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback',
      resource: RESOURCE
    });
    for (let i = 0; i < 3; i++) {
      token = await server.refreshUserToken({ refreshToken: token.refreshToken, clientId: 'client-mcp' });
      expect(decodeJwt(token.accessToken).aud).toBe(RESOURCE);
    }
  });

  it('still falls back to the application audience when no resource was ever named', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    const first = await server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback'
    });
    const refreshed = await server.refreshUserToken({ refreshToken: first.refreshToken, clientId: 'client-mcp' });

    expect(decodeJwt(refreshed.accessToken).aud).toBe('identity-console');
  });

  it('rejects an unrecognized resource at the authorization request, before any login prompt', async () => {
    await expect(server.startAuthorization(authorizeArgs('verifier-abc-123', { resource: 'https://evil.test/mcp' })))
      .rejects.toBeInstanceOf(InvalidTargetError);
    expect(store.authorizations).toHaveLength(0); // nothing persisted
  });

  it('rejects an exchange that names a different resource than the authorization did', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier, { resource: RESOURCE }));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    await expect(server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback',
      resource: 'https://evil.test/mcp'
    })).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it('rejects an exchange naming a resource when the authorization named none', async () => {
    const verifier = 'verifier-abc-123';
    const started = await server.startAuthorization(authorizeArgs(verifier));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });

    await expect(server.issueAuthorizationCodeToken({
      code: store.authorizations[0].code,
      codeVerifier: verifier,
      clientId: 'client-mcp',
      redirectUri: 'http://localhost:9876/callback',
      resource: RESOURCE
    })).rejects.toBeInstanceOf(InvalidTargetError);
  });
});

/**
 * The registry that lets a product OTHER than identity-service put its own MCP endpoint behind this
 * authorization server. Before it, the only acceptable `resource` was this service's own MCP URL, so a
 * client naming e.g. Skills Coach's endpoint was refused `invalid_target` at `/oauth2/authorize` — an
 * HTTP 400 raised before any browser opened, which presents as "nothing happened" rather than as an
 * auth error.
 */
describe('Per-application protected-resource registry (ADR-0009 Phase 2, ADR-0020)', () => {
  let store: Store;
  let server: ReturnType<typeof createOAuthServer>;
  const now = () => new Date('2026-08-06T12:00:00.000Z');
  const COACH_RESOURCE = 'https://coach-mcp.fps4.nl/mcp';

  beforeEach(() => {
    store = makeStore();
    seedClient(store);
    // The client's own application owns the resource it wants its token audience-bound to.
    store.applications[0].resources = [COACH_RESOURCE];
    server = createOAuthServer(makeDeps(store, now) as any);
  });

  const login = async (verifier: string, resource?: string) => {
    const started = await server.startAuthorization(authorizeArgs(verifier, resource ? { resource } : {}));
    const loginToken = started.mode === 'login' ? started.loginToken : '';
    await server.completeLocalLogin({ loginToken, email: 'operator@fps4.test', password: PASSWORD });
  };

  const exchange = (verifier: string, resource?: string) => server.issueAuthorizationCodeToken({
    code: store.authorizations[0].code,
    codeVerifier: verifier,
    clientId: 'client-mcp',
    redirectUri: 'http://localhost:9876/callback',
    resource
  });

  it("binds a user token to a resource the credential's own application declares", async () => {
    const verifier = 'verifier-abc-123';
    await login(verifier, COACH_RESOURCE);
    const token = await exchange(verifier, COACH_RESOURCE);

    expect(decodeJwt(token.accessToken).aud).toBe(COACH_RESOURCE);
  });

  it("keeps this service's own MCP resource acceptable alongside the application's", async () => {
    const verifier = 'verifier-abc-123';
    await login(verifier, CONFIG.mcp.resourceUrl);
    const token = await exchange(verifier, CONFIG.mcp.resourceUrl);

    expect(decodeJwt(token.accessToken).aud).toBe(CONFIG.mcp.resourceUrl);
  });

  it('refuses a resource that belongs to a DIFFERENT application', async () => {
    // A second product registers its own endpoint. This client's application must not be able to name
    // it, or one product's credential could mint a token another product's resource server accepts.
    store.applications.push({ _id: 'app-other', name: 'Other', audience: 'other', roles: [], resources: ['https://other-mcp.fps4.nl/mcp'] });

    await expect(server.startAuthorization(authorizeArgs('verifier-abc-123', { resource: 'https://other-mcp.fps4.nl/mcp' })))
      .rejects.toBeInstanceOf(InvalidTargetError);
    expect(store.authorizations).toHaveLength(0); // nothing persisted
  });

  it("refuses the application's resource once it is removed from the registry", async () => {
    store.applications[0].resources = [];
    await expect(server.startAuthorization(authorizeArgs('verifier-abc-123', { resource: COACH_RESOURCE })))
      .rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("re-mints the application's resource as the aud across a refresh", async () => {
    const verifier = 'verifier-abc-123';
    await login(verifier, COACH_RESOURCE);
    const first = await exchange(verifier, COACH_RESOURCE);

    const refreshed = await server.refreshUserToken({ refreshToken: first.refreshToken, clientId: 'client-mcp' });

    expect(decodeJwt(refreshed.accessToken).aud).toBe(COACH_RESOURCE);
  });
});
