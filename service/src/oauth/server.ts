import { randomUUID, randomBytes } from 'crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { CONFIG } from '../config.js';
import type {
  OAuthServerDependencies,
  ClientCredentialsInput,
  TokenResponse,
  StartAuthorizationInput,
  StartAuthorizationResult,
  LocalLoginInput,
  LocalLoginResult,
  HandleCallbackInput,
  HandleCallbackResult,
  AuthorizationCodeInput,
  RefreshTokenInput,
  RevokeTokenInput,
  PasswordGrantInput,
  UserTokenResponse
} from './types.js';
import {
  InvalidClientError,
  UnauthorizedClientError,
  InvalidScopeError,
  InvalidRequestError,
  RateLimitExceededError,
  InvalidGrantError,
  AccessDeniedError,
  InvalidTargetError
} from './errors.js';
import { verifySecret, sha256Hex } from '../utils/hash.js';
import { getActiveKeyPair } from '../utils/key-store.js';
import { verifyPkceS256 } from './pkce.js';
import { createGoogleIdp, type GoogleIdp } from './google.js';
import type { OAuthClientDocument } from '../models/oauth-client.js';
import type { UserDocument } from '../models/user.js';
import type { ApplicationDocument } from '../models/application.js';
import type { OAuthAuthorizationDocument } from '../models/oauth-authorization.js';
import { ConditionFailed, type Store } from '../db/index.js';
import { ensureClientPrincipal, ensureUserPrincipal, mintPrincipalId, principalRow, realmOf, selfContext, createRecorder, withRecordTransaction } from '../record/index.js';

const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
const GRANT_AUTHORIZATION_CODE = 'authorization_code';
const GRANT_PASSWORD = 'password';
const GOOGLE_SCOPE = ['openid', 'email', 'profile'];

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createOAuthServer(deps: OAuthServerDependencies) {
  const nowFn = deps.now ?? (() => new Date());
  const { store } = deps;
  // Built lazily so client-credentials-only deployments (no Google config) never construct it.
  let googleIdpInstance: GoogleIdp | undefined = deps.googleIdp;
  const isGoogleConfigured = (): boolean =>
    Boolean(googleIdpInstance) ||
    Boolean(CONFIG.google.clientId && CONFIG.google.clientSecret && CONFIG.google.redirectUri);
  const getGoogleIdp = (): GoogleIdp => {
    if (!googleIdpInstance) {
      if (!isGoogleConfigured()) {
        throw new InvalidRequestError('Google login is not configured on this service');
      }
      googleIdpInstance = createGoogleIdp(CONFIG.google);
    }
    return googleIdpInstance;
  };

  /**
   * The protected resources a token may be bound to (RFC 8707): this service's own MCP resource, plus
   * whatever the *credential's own application* declares it owns (ADR-0020 `resources`). Scoping the
   * registry to the application is what stops one product's credential minting a token audienced at
   * another product's resource; before it existed, only this service's own MCP URL was ever accepted, so
   * no other product could put its MCP endpoint behind this authorization server at all.
   *
   * Read from CONFIG at call time so a deployment's resource URL is not frozen at module load.
   */
  function assertAllowedResource(resource: string, application: { resources?: string[] } | null): void {
    const allowedResources = [CONFIG.mcp.resourceUrl, ...(application?.resources ?? [])];
    if (!allowedResources.includes(resource)) {
      throw new InvalidTargetError(`Unknown resource: ${resource}`);
    }
  }

  /**
   * The `aud` of a user token. An RFC 8707 resource indicator wins when the caller names one
   * (audience-binding, ADR-0009 Phase 2) — that is how an MCP client gets a token its resource server
   * will accept, since the MCP resource is not the application's own audience. Otherwise the
   * credential override / application default applies (ADR-0020).
   */
  function resolveUserAudience(
    client: { audience?: string },
    application: { audience?: string; resources?: string[] } | null,
    resource?: string
  ): string {
    if (resource) {
      assertAllowedResource(resource, application);
      return resource;
    }
    // A user token is only meaningful if it can be audience-bound to a consumer (RQ-0001 AC4).
    const audience = effectiveAudience(client, application);
    if (!audience) {
      throw new UnauthorizedClientError('Application has no audience configured for user tokens');
    }
    return audience;
  }

  async function issueClientCredentialsToken(input: ClientCredentialsInput): Promise<TokenResponse> {
    if (!input.clientId || !input.clientSecret) {
      throw new InvalidRequestError('client_id and client_secret are required');
    }

    const client = await store.clients.get(input.clientId);
    if (!client) {
      throw new InvalidClientError('Client not found');
    }

    if (!client.isConfidential) {
      throw new UnauthorizedClientError('Client credentials grant requires confidential client');
    }

    if (!verifySecret(input.clientSecret, client.secretHash)) {
      throw new InvalidClientError('Client secret mismatch');
    }

    if (!client.grantTypes.includes(GRANT_CLIENT_CREDENTIALS)) {
      throw new UnauthorizedClientError('Grant type not allowed for client');
    }

    // Scope is constrained by the client's own allow-list (ADR-0018: no tenant layer above the client).
    const requestedScope = input.scope ?? [];
    let candidateScopes = requestedScope.length ? [...requestedScope] : [...(client.scopes ?? [])];
    if (!candidateScopes.length && CONFIG.oauth.defaultClientCredentialsScopes.length) {
      candidateScopes = [...CONFIG.oauth.defaultClientCredentialsScopes];
    }

    const allowedScopes = new Set(client.scopes ?? []);
    const effectiveScopes: string[] = [];
    for (const scope of candidateScopes) {
      if (!allowedScopes.has(scope)) {
        throw new InvalidScopeError(`Scope ${scope} not permitted for client`);
      }
      if (!effectiveScopes.includes(scope)) {
        effectiveScopes.push(scope);
      }
    }

    const issuedAt = nowFn();
    await enforceRateLimit(store, issuedAt, CONFIG.oauth.limits.maxAccessTokensPerMinute);
    const expiresIn = CONFIG.oauth.accessTokenTtlSec;
    const expDate = new Date(issuedAt.getTime() + expiresIn * 1000);
    const jti = randomUUID();

    const keyPair = await getActiveKeyPair();
    const privateKey = await importPKCS8(keyPair.privateKeyPem, 'RS256');

    // Extra, additive claims the client carries (US-0086) — e.g. a product_runtime credential's
    // `role` + `email`, which the resource server matches its principal on. Spread first so the
    // controlled claims below (and the signer's registered claims) always win; never let a stored
    // claim override identity.
    const extraClaims = (client.claims && typeof client.claims === 'object') ? client.claims : {};
    const payload: Record<string, unknown> = {
      ...extraClaims,
      cid: client._id,
      scope: effectiveScopes.join(' '),
      sub: input.subject ?? client.subject ?? client._id
    };
    if (input.sessionId) {
      payload.sid = input.sessionId;
    }
    // The credential's maestro principal (ADR-0022): `prn` is the id maestro's record names, minted here
    // and backfilled on first use. `principal_kind` stays as consumers read it today — the credential's
    // own declaration passes through; a machine credential that declares none is a `workload`.
    if (deps.record) {
      const principal = await ensureClientPrincipal(store, client);
      if (principal) {
        payload.prn = principal.id;
        if (typeof payload.principal_kind !== 'string') payload.principal_kind = principal.kind;
      }
    }

    // Per-client audience when configured (US-0086) — a machine principal is audience-bound to one
    // workspace (e.g. `maestro-workspace`) exactly like a user token, falling back to the service-wide
    // default for an unscoped client.
    //
    // RFC 8707 resource indicator (ADR-0009 Phase 2): if the caller names a protected resource its own
    // application owns, bind the token's `aud` to it instead — so the token is only accepted at that
    // resource. An unrecognized resource is rejected rather than silently issuing a broadly-scoped token.
    // Audience: a credential override wins, else the application default, else the service-wide default.
    const application = client.applicationId
      ? await store.applications.get(client.applicationId)
      : null;
    let audience = effectiveAudience(client, application) ?? CONFIG.auth.jwtAudience;
    if (input.resource) {
      assertAllowedResource(input.resource, application);
      audience = input.resource;
    }

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: keyPair.kid, typ: 'JWT' })
      .setIssuer(CONFIG.auth.jwtIssuer)
      .setAudience(audience)
      .setJti(jti)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expDate.getTime() / 1000))
      .sign(privateKey);

    await store.tokens.create({
      _id: jti,
      clientId: client._id,
      subject: payload.sub as string,
      sessionId: input.sessionId,
      type: 'access',
      scope: effectiveScopes,
      expiresAt: expDate,
      issuedAt,
      status: 'active'
    });

    deps.logger?.info?.({ clientId: client._id, scopes: effectiveScopes }, 'issued client credentials token');

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn,
      scope: effectiveScopes
    };
  }

  // --- User login flow (RQ-0001: Google SSO, OIDC Authorization Code + PKCE) ---

  /**
   * Load + validate a client for a user-token grant (`authorization_code` or `password`). The client's
   * own `grantTypes` is the sole gate (ADR-0018: no tenant layer above the client).
   */
  async function loadFlowClient(clientId: string, grantType: string): Promise<{
    client: OAuthClientDocument;
  }> {
    const client = await store.clients.get(clientId);
    if (!client) {
      throw new InvalidClientError('Client not found');
    }
    if (!client.grantTypes.includes(grantType)) {
      throw new UnauthorizedClientError(`Grant ${grantType} not allowed for client`);
    }
    return { client };
  }

  async function startAuthorization(input: StartAuthorizationInput): Promise<StartAuthorizationResult> {
    if ((input.codeChallengeMethod ?? 'S256') !== 'S256') {
      throw new InvalidRequestError('Only the S256 PKCE method is supported');
    }
    if (!input.codeChallenge) {
      throw new InvalidRequestError('code_challenge is required');
    }
    if (!input.redirectUri) {
      throw new InvalidRequestError('redirect_uri is required');
    }

    // Which provider authenticates this person. Google when the deployment configures it, otherwise
    // this service's own local-credential IdP (RQ-0002) — so an install with no external IdP is still
    // able to log a human in, rather than failing the browser leg outright. A deployment with neither
    // genuinely cannot serve an interactive login, and says so.
    const idpKind: 'google' | 'local' = isGoogleConfigured() ? 'google' : 'local';
    if (idpKind === 'local' && !CONFIG.auth.localIdpEnabled) {
      throw new InvalidRequestError('No interactive login is configured on this service');
    }

    const { client } = await loadFlowClient(input.clientId, GRANT_AUTHORIZATION_CODE);

    // The redirect_uri MUST be pre-registered on the client (open-redirect / token-theft guard).
    if (!client.redirectUris?.includes(input.redirectUri)) {
      throw new InvalidRequestError('redirect_uri is not registered for this client');
    }
    // Resolve the audience now, so a request naming an unknown resource — or a client whose
    // application has no audience — fails before a login prompt is ever shown.
    const application = await requireApplication(store, client);
    resolveUserAudience(client, application, input.resource);

    const requestedScope = input.scope ?? [];
    const allowedScopes = new Set(client.scopes ?? []);
    const scope = requestedScope.filter((s) => allowedScopes.has(s));

    const issuedAt = nowFn();
    const googleState = randomToken();
    const nonce = randomToken();
    const loginToken = idpKind === 'local' ? randomToken() : undefined;
    const expiresAt = new Date(issuedAt.getTime() + CONFIG.oauth.authorizationTtlSec * 1000);

    await store.authorizations.create({
      _id: randomUUID(),
      clientId: client._id,
      consumerRedirectUri: input.redirectUri,
      consumerState: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
      scope,
      idp: idpKind,
      resource: input.resource,
      loginToken,
      googleState,
      nonce,
      status: 'pending',
      expiresAt,
      createdAt: issuedAt
    });

    deps.logger?.info?.({ clientId: client._id, idp: idpKind }, 'started user authorization');
    if (idpKind === 'local') {
      return { mode: 'login', loginToken: loginToken as string, redirectUri: input.redirectUri };
    }
    return {
      mode: 'redirect',
      redirectTo: getGoogleIdp().buildAuthorizationUrl({ state: googleState, nonce, scope: GOOGLE_SCOPE })
    };
  }

  /**
   * The pre-registered redirect target of a pending local login, so a re-rendered login page can name it
   * in its CSP `form-action` (see StartAuthorizationResult). Read-only and non-committal: it neither
   * consumes the login nor reveals anything the consumer did not already supply. Null when the login is
   * unknown, expired, or already used.
   */
  async function getLoginContext(loginToken: string): Promise<{ redirectUri: string } | null> {
    if (!loginToken) return null;
    const record = await pendingByLoginToken(loginToken);
    if (!record?.consumerRedirectUri) return null;
    if (record.expiresAt && record.expiresAt.getTime() < nowFn().getTime()) return null;
    return { redirectUri: record.consumerRedirectUri };
  }

  /**
   * Complete an interactive login against the local-credential IdP (RQ-0002) — the first-party
   * equivalent of the Google callback leg. `loginToken` is the unguessable, single-use handle minted
   * with the form, so the POST is bound to the authorization request that produced it; no cookie or
   * ambient session is involved, which is also why there is no separate CSRF token to carry (a forged
   * cross-site POST would still have to supply the person's password).
   */
  async function completeLocalLogin(input: LocalLoginInput): Promise<LocalLoginResult> {
    if (!input.loginToken) {
      throw new InvalidRequestError('login_token is required');
    }
    const record = await pendingByLoginToken(input.loginToken);
    if (!record || record.expiresAt.getTime() < nowFn().getTime()) {
      throw new AccessDeniedError('Login session is invalid or expired');
    }
    if (record.idp !== 'local') {
      throw new AccessDeniedError('This authorization does not use local login');
    }
    // Re-check at submit: an operator may have disabled the local IdP mid-flight.
    if (!CONFIG.auth.localIdpEnabled) {
      throw new AccessDeniedError('Local login is disabled on this service');
    }

    const user = await authenticateLocalUser(input.email, input.password);

    // Single-use: the form handle dies with the login it authorized; a local login's subject IS the user
    // record id. A form submitted twice finds the login no longer pending.
    const code = randomToken();
    const authenticated = await store.authorizations.authenticate(record, { code, email: user.email, sub: user._id, emailVerified: user.emailVerified === true });
    if (!authenticated) {
      throw new AccessDeniedError('Login session is invalid or expired');
    }

    const sep = record.consumerRedirectUri.includes('?') ? '&' : '?';
    const params = new URLSearchParams({ code });
    if (record.consumerState) params.set('state', record.consumerState);
    deps.logger?.info?.({ clientId: record.clientId, userId: user._id }, 'local authentication succeeded');
    return { redirectTo: `${record.consumerRedirectUri}${sep}${params.toString()}` };
  }

  async function handleGoogleCallback(input: HandleCallbackInput): Promise<HandleCallbackResult> {
    if (!input.state || !input.code) {
      throw new AccessDeniedError('Missing code or state on callback');
    }
    const idp = getGoogleIdp();

    const found = await store.authorizations.getByState(input.state);
    const record = found && found.status === 'pending' ? found : null;
    // No trusted redirect target without a matching, unexpired record — deny outright.
    if (!record || record.expiresAt.getTime() < nowFn().getTime()) {
      throw new AccessDeniedError('Authorization state is invalid or expired');
    }

    const appendError = (uri: string): string => {
      const sep = uri.includes('?') ? '&' : '?';
      const params = new URLSearchParams({ error: 'access_denied' });
      if (record.consumerState) params.set('state', record.consumerState);
      return `${uri}${sep}${params.toString()}`;
    };

    try {
      const { idToken } = await idp.exchangeCode(input.code);
      const identity = await idp.verifyIdToken(idToken, { nonce: record.nonce });

      // Invite-only/closed deployments do not JIT-provision new people (RQ-0013). Pre-empt here so the
      // user lands back at the consumer with a standard OAuth error instead of a late token-exchange
      // failure; `provisionFederatedUser` re-enforces this at exchange as the authoritative gate.
      const registration = CONFIG.auth.registrationMode;
      if (registration !== 'open') {
        const existing = (await store.users.getByIdentity('google', identity.sub))
          ?? (await store.users.getByEmail(identity.email.trim().toLowerCase()));
        if (!existing) {
          throw new AccessDeniedError('Sign-up is not open');
        }
      }

      const code = randomToken();
      const authenticated = await store.authorizations.authenticate(record, { code, email: identity.email, sub: identity.sub, emailVerified: identity.emailVerified });
      if (!authenticated) {
        throw new AccessDeniedError('Authorization state is invalid or expired');
      }

      const sep = record.consumerRedirectUri.includes('?') ? '&' : '?';
      const params = new URLSearchParams({ code });
      if (record.consumerState) params.set('state', record.consumerState);
      const redirectTo = `${record.consumerRedirectUri}${sep}${params.toString()}`;
      deps.logger?.info?.({ clientId: record.clientId }, 'google authentication succeeded');
      return { redirectTo };
    } catch (error) {
      // Google leg failed — redirect back to the (registered, therefore trusted) consumer with a
      // standard OAuth error, minting no token (RQ-0001 AC).
      deps.logger?.error?.({ err: error, clientId: record.clientId }, 'google authentication failed');
      return { redirectTo: appendError(record.consumerRedirectUri) };
    }
  }

  async function issueAuthorizationCodeToken(input: AuthorizationCodeInput): Promise<UserTokenResponse> {
    if (!input.code || !input.codeVerifier) {
      throw new InvalidRequestError('code and code_verifier are required');
    }
    const found = await store.authorizations.getByCode(input.code);
    const record = found && found.status === 'authenticated' && found.code === input.code ? found : null;
    if (!record || record.expiresAt.getTime() < nowFn().getTime()) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }
    if (record.clientId !== input.clientId) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (record.consumerRedirectUri !== input.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (!verifyPkceS256(input.codeVerifier, record.codeChallenge)) {
      throw new InvalidGrantError('PKCE verification failed');
    }
    if (!record.email || !record.sub) {
      throw new InvalidGrantError('Authorization has no established identity');
    }

    const { client } = await loadFlowClient(record.clientId, GRANT_AUTHORIZATION_CODE);

    // RFC 8707: a resource repeated at the exchange must be the one the authorization named. Silently
    // honouring a different one would let the exchange re-target a token the person never approved.
    if (input.resource && input.resource !== (record.resource ?? undefined)) {
      throw new InvalidTargetError('resource does not match the authorization request');
    }

    // Single-use: consume the code before issuing, so a replay cannot mint a second token. The consume
    // is conditional on the code still being unconsumed — two exchanges racing get one token between them.
    if (!(await store.authorizations.consume(record._id))) {
      throw new InvalidGrantError('Authorization code is invalid or expired');
    }

    // Resolve the person behind the login. A local login (RQ-0002) already authenticated a real user
    // record, so there is nothing to provision — only to re-check, since status/lockout may have
    // changed between the login and this exchange. A federated login JIT-provisions or links the
    // Google identity and applies the same status + roles rules (RQ-0011 US-2/US-3/US-4):
    // `provisionFederatedUser` throws if the account is disabled/locked, an unverified email would
    // collide, or the deployment's registration policy forbids creating a new user (RQ-0013).
    const user = record.idp === 'local'
      ? await requireLocalUser(record.sub)
      : await provisionFederatedUser({
        provider: 'google',
        subject: record.sub,
        email: record.email,
        emailVerified: record.emailVerified === true,
        registration: CONFIG.auth.registrationMode
      });

    // Entitlement gate (ADR-0019/0020): even a freshly JIT-provisioned federated user needs an active
    // assignment for this credential's application (created by an invite or an operator) before a token.
    const application = await requireApplication(store, client);
    const assignment = await store.assignments.getActive(user._id, application._id);
    if (!assignment) {
      throw new AccessDeniedError('User is not assigned to this application');
    }

    return issueUserTokens({
      client,
      audience: resolveUserAudience(client, application, record.resource),
      // Token claims are unchanged from RQ-0001: the email + stable `sub` the IdP asserted. The user
      // record is a resolution layer behind the token, never a change to it (ADR-0012). The `prn` claim
      // (ADR-0022) is additive: the person's maestro principal id, whichever IdP asserted the `sub`.
      email: record.email,
      sub: record.sub,
      prn: await principalClaimFor(user),
      scope: record.scope ?? [],
      roles: assignment.roles ?? [],
      resource: record.resource
    });
  }

  /** A pending login by its form handle, or null when unknown, expired-by-status, or already used. */
  async function pendingByLoginToken(loginToken: string): Promise<OAuthAuthorizationDocument | null> {
    const found = await store.authorizations.getByLoginToken(loginToken);
    return found && found.status === 'pending' && found.loginToken === loginToken ? found : null;
  }

  /** Re-read the person behind a completed local login. Unlike the federated leg there is nothing to
   *  provision — but status/lockout is re-enforced, so an account disabled between login and exchange
   *  still gets no token (RQ-0011 US-3). */
  async function requireLocalUser(sub: string): Promise<UserDocument> {
    const user = await store.users.get(sub);
    if (!user) {
      throw new InvalidGrantError('User no longer exists');
    }
    assertUserActive(user);
    return user;
  }

  /**
   * Verify an email + password against the local-credential IdP (RQ-0002), enforcing the temporal
   * brute-force lockout and clearing the counters on success. Shared by the non-interactive `password`
   * grant and the interactive login leg, so both get identical lockout behaviour.
   *
   * Failure is uniform — an unknown email, a federated-only account (no `passwordHash`, RQ-0011), and a
   * wrong password are indistinguishable to the caller, so neither path enumerates users.
   */
  async function authenticateLocalUser(username: string, password: string): Promise<UserDocument> {
    const email = username.trim().toLowerCase();
    const user = await store.users.getByEmail(email);
    const now = nowFn();

    const genericDenied = () => new InvalidGrantError('Invalid credentials');

    if (!user || user.status === 'disabled' || !user.passwordHash) {
      throw genericDenied();
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      throw new InvalidGrantError('Account is temporarily locked');
    }

    if (!verifySecret(password, user.passwordHash)) {
      let failedAttempts = (user.failedAttempts ?? 0) + 1;
      let lockedUntil = user.lockedUntil ?? null;
      if (failedAttempts >= CONFIG.auth.password.maxFailedAttempts) {
        lockedUntil = new Date(now.getTime() + CONFIG.auth.password.lockoutMinutes * 60 * 1000);
        failedAttempts = 0;
        deps.logger?.info?.({ userId: user._id }, 'user locked after failed logins');
      }
      await store.users.update(user._id, { failedAttempts, lockedUntil, updatedAt: now });
      throw genericDenied();
    }

    // Success: clear the brute-force counters.
    if (user.failedAttempts || user.lockedUntil) {
      await store.users.update(user._id, { failedAttempts: 0, lockedUntil: null, updatedAt: now });
      user.failedAttempts = 0;
      user.lockedUntil = null;
    }

    return user;
  }

  async function issuePasswordToken(input: PasswordGrantInput): Promise<UserTokenResponse> {
    if (!input.username || !input.password) {
      throw new InvalidRequestError('username and password are required');
    }
    const { client } = await loadFlowClient(input.clientId, GRANT_PASSWORD);

    const user = await authenticateLocalUser(input.username, input.password);

    // Entitlement gate (ADR-0019/0020): the user must hold an active assignment for this credential's
    // application; the token's roles are the app-scoped roles from that assignment.
    const application = await requireApplication(store, client);
    const assignment = await store.assignments.getActive(user._id, application._id);
    if (!assignment) {
      throw new AccessDeniedError('User is not assigned to this application');
    }

    return issueUserTokens({
      client,
      audience: effectiveAudience(client, application),
      email: user.email,
      sub: user._id, // the stable subject id
      prn: await principalClaimFor(user),
      scope: [],
      roles: assignment.roles ?? []
    });
  }

  async function refreshUserToken(input: RefreshTokenInput): Promise<UserTokenResponse> {
    if (!input.refreshToken) {
      throw new InvalidRequestError('refresh_token is required');
    }
    const hashed = sha256Hex(input.refreshToken);
    const tokenDoc = await store.tokens.getRefreshByHash(hashed);
    const now = nowFn();
    if (!tokenDoc || tokenDoc.status !== 'active' || tokenDoc.expiresAt.getTime() < now.getTime()) {
      throw new InvalidGrantError('Refresh token is invalid, expired, or revoked');
    }
    if (tokenDoc.clientId !== input.clientId) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }

    // A refresh MUST NOT outlive a revoked session (RQ-0001 AC6).
    const session = tokenDoc.sessionId
      ? await store.sessions.get(tokenDoc.sessionId)
      : null;
    if (!session || session.status !== 'active' || session.expiresAt.getTime() < now.getTime()) {
      throw new InvalidGrantError('Session is revoked or expired');
    }

    // Refresh is grant-agnostic — the client was already vetted at the original login. Just confirm
    // it still exists (audience needed to re-mint); don't require a specific login grant here.
    const client = await store.clients.get(tokenDoc.clientId);
    if (!client) {
      throw new InvalidGrantError('Client no longer exists');
    }
    const email = (session.context as { email?: string } | null)?.email ?? undefined;
    const sub = tokenDoc.subject;
    if (!sub) {
      throw new InvalidGrantError('Refresh token has no subject');
    }

    // A refresh must honour a user disabled/locked since login (RQ-0011 US-3) and re-check the
    // application assignment (ADR-0019) — a suspended/revoked assignment kills further tokens, and the
    // current app-scoped roles are re-read from it.
    const user = await store.users.getBySubject(sub);
    if (!user) {
      throw new InvalidGrantError('User no longer exists');
    }
    assertUserActive(user);
    const application = await requireApplication(store, client);
    const assignment = await store.assignments.getActive(user._id, application._id);
    if (!assignment) {
      throw new InvalidGrantError('Access to this application was revoked');
    }

    // Rotate: the presented refresh token is single-use.
    await store.tokens.setStatus(tokenDoc._id, 'revoked');

    // Re-mint against the SAME resource the chain was bound to (ADR-0009 Phase 2). Dropping it here
    // would hand back a token audienced at the application instead, which the resource server must
    // reject — and because that only bites at the first refresh, the login itself looks perfectly fine.
    return issueUserTokens({
      client,
      audience: resolveUserAudience(client, application, tokenDoc.resource),
      email,
      sub,
      prn: await principalClaimFor(user),
      scope: tokenDoc.scope ?? [],
      roles: assignment.roles ?? [],
      session,
      resource: tokenDoc.resource
    });
  }

  async function revokeUserToken(input: RevokeTokenInput): Promise<void> {
    if (!input.token) return; // RFC 7009: revocation is idempotent; unknown tokens succeed silently.
    const hashed = sha256Hex(input.token);
    const tokenDoc = await store.tokens.getRefreshByHash(hashed);
    if (!tokenDoc) return;

    await store.tokens.setStatus(tokenDoc._id, 'revoked');

    // Cascade to the session so any sibling refresh token is also dead (AC6).
    if (tokenDoc.sessionId) {
      await store.sessions.update(tokenDoc.sessionId, { status: 'revoked', updatedAt: nowFn() });
    }
    deps.logger?.info?.({ clientId: tokenDoc.clientId, sessionId: tokenDoc.sessionId }, 'revoked user session');
  }

  /** Deny issuance for a person an operator has disabled or who is inside a brute-force lockout window.
   *  Enforced on every user grant so the guarantee holds regardless of provider (RQ-0011 US-3). */
  /** The person's `prn` claim (ADR-0022) — minted on first use for a record that predates the registry. */
  async function principalClaimFor(user: { _id: string; principalId?: string; status?: string }): Promise<string | undefined> {
    if (!deps.record) return undefined;
    return (await ensureUserPrincipal(store, user)).id;
  }

  function assertUserActive(user: { status?: string; lockedUntil?: Date | null }): void {
    if (user.status === 'disabled') {
      throw new InvalidGrantError('Account is disabled');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > nowFn().getTime()) {
      throw new InvalidGrantError('Account is temporarily locked');
    }
  }

  /**
   * Just-in-time provision the user behind a federated login (RQ-0011 US-2/US-4). Resolution order:
   *   1. the identity `(provider, subject)` is already linked → returning user (refresh email + login).
   *   2. a user with the same email exists → link this identity onto it, but ONLY if the provider
   *      vouched the email (`email_verified`); an unverified collision is denied, never merged (US-4).
   *   3. otherwise → create a new federated-only user (no password) — unless the deployment's
   *      registration policy is `invite`/`closed`, which gates JIT creation too (RQ-0013): an
   *      invitee registers locally with their code first, then Google links via rule 2.
   * Enforces `status`/lockout on an existing account before issuing (US-3). Idempotent under the
   * concurrent-first-login race via the unique identity index.
   */
  async function provisionFederatedUser(
    args: { provider: 'google'; subject: string; email: string; emailVerified: boolean; registration?: 'open' | 'invite' | 'closed' }
  ): Promise<UserDocument> {
    const now = nowFn();
    const emailNorm = args.email.trim().toLowerCase();
    const { provider, subject } = args;

    // 1) Identity already linked.
    const linked = await store.users.getByIdentity(provider, subject);
    if (linked) {
      assertUserActive(linked);
      const identities = (linked.identities ?? []).map((i) =>
        i.provider === provider && i.subject === subject ? { ...i, email: emailNorm, emailVerified: args.emailVerified } : i
      );
      await store.users.setIdentities(linked, identities, now, { lastLoginAt: now });
      return { ...linked, identities, lastLoginAt: now };
    }

    // 2) An account with this email exists — link only on a verified email (account-takeover guard).
    const byEmail = await store.users.getByEmail(emailNorm);
    if (byEmail) {
      if (!args.emailVerified) {
        throw new AccessDeniedError('Cannot link an unverified email to an existing account');
      }
      assertUserActive(byEmail);
      const identity = { provider, subject, email: emailNorm, emailVerified: true, linkedAt: now };
      await store.users.linkIdentity(byEmail, identity, now);
      return { ...byEmail, identities: [...(byEmail.identities ?? []), identity], lastLoginAt: now };
    }

    // 3) First sighting of this person — create a federated-only user. On an invite-only/closed
    //    deployment this is exactly the walk-around ADR-0013 closes: deny instead of provisioning.
    if ((args.registration ?? 'open') !== 'open') {
      throw new AccessDeniedError('Sign-up is not open');
    }
    const record = deps.record;
    const userId = randomUUID();
    const principalId = record ? mintPrincipalId('human') : undefined;
    const user: UserDocument = {
      _id: userId,
      email: emailNorm,
      emailVerified: args.emailVerified,
      status: 'active',
      failedAttempts: 0,
      identities: [{ provider, subject, email: emailNorm, emailVerified: args.emailVerified, linkedAt: now }],
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
      ...(principalId ? { principalId } : {})
    };
    try {
      // A first sighting registers a HUMAN principal on maestro's record (ADR-0022): the person acts for
      // themselves, in the `self` seat, and the event lands in the same transaction as the account.
      await withRecordTransaction(store, async (tx) => {
        store.users.put(tx, user);
        if (record && principalId) {
          store.principals.register(tx, principalRow(principalId, 'human', 'active', 'user', userId, now));
          const recorder = createRecorder({ store, config: record, ...selfContext({ id: principalId, kind: 'human' }), logger: deps.logger, now: () => nowFn().toISOString() });
          await recorder.emit(tx, [{
            type: 'PrincipalRegistered',
            subject: principalId,
            body: { kind: 'human', source: 'google', realm: realmOf(record.workspaceId) }
          }]);
        }
      }, deps.logger);
      return user;
    } catch (err) {
      // Concurrent first login: the identity was claimed by the other request — re-read it.
      if (err instanceof ConditionFailed) {
        const raced = await store.users.getByIdentity(provider, subject);
        if (raced) {
          assertUserActive(raced);
          return raced;
        }
      }
      throw err;
    }
  }

  /**
   * Mint an access JWT + a rotating refresh token for a verified user identity, persisting their
   * metadata and (on first issue) the session. Reused by the authorization-code and refresh grants.
   */
  async function issueUserTokens(
    args: {
      client: OAuthClientDocument;
      audience?: string; // resolved from the resource indicator / credential override / application (ADR-0020)
      email?: string;
      sub: string;
      /** The person's maestro principal id — the `prn` claim (ADR-0022). */
      prn?: string;
      scope: string[];
      roles?: string[];
      session?: { _id: string; expiresAt: Date };
      /** The resource the audience came from, persisted so a later refresh re-mints the same `aud`. */
      resource?: string;
    }
  ): Promise<UserTokenResponse> {
    if (!args.audience) {
      throw new UnauthorizedClientError('Application has no audience configured for user tokens');
    }
    const issuedAt = nowFn();
    const accessExpiresIn = CONFIG.oauth.accessTokenTtlSec;
    const accessExp = new Date(issuedAt.getTime() + accessExpiresIn * 1000);

    // The session bounds the absolute lifetime; refresh tokens never outlive it.
    let sessionId: string;
    let sessionExpiresAt: Date;
    if (args.session) {
      sessionId = args.session._id;
      sessionExpiresAt = args.session.expiresAt;
    } else {
      sessionId = randomUUID();
      sessionExpiresAt = new Date(issuedAt.getTime() + CONFIG.oauth.refreshTokenTtlSec * 1000);
      await store.sessions.create({
        _id: sessionId,
        contactId: args.sub,
        context: args.email ? { email: args.email } : {},
        status: 'active',
        expiresAt: sessionExpiresAt,
        createdAt: issuedAt,
        updatedAt: issuedAt
      });
    }

    const jti = randomUUID();
    const accessToken = await signUserAccessToken({
      jti,
      audience: args.audience,
      email: args.email,
      sub: args.sub,
      prn: args.prn,
      scope: args.scope,
      roles: args.roles,
      issuedAt,
      expiresAt: accessExp
    });

    await store.tokens.create({
      _id: jti,
      clientId: args.client._id,
      subject: args.sub,
      sessionId,
      type: 'access',
      scope: args.scope,
      expiresAt: accessExp,
      issuedAt,
      status: 'active',
      resource: args.resource
    });

    // Opaque, high-entropy refresh token — only its hash is stored.
    const refreshTokenValue = randomToken();
    const refreshJti = randomUUID();
    await store.tokens.create({
      _id: refreshJti,
      clientId: args.client._id,
      subject: args.sub,
      sessionId,
      type: 'refresh',
      scope: args.scope,
      expiresAt: sessionExpiresAt,
      issuedAt,
      status: 'active',
      resource: args.resource,
      hashedToken: sha256Hex(refreshTokenValue)
    });

    const refreshExpiresIn = Math.max(0, Math.floor((sessionExpiresAt.getTime() - issuedAt.getTime()) / 1000));
    deps.logger?.info?.({ clientId: args.client._id, sub: args.sub }, 'issued user token');

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: accessExpiresIn,
      refreshToken: refreshTokenValue,
      refreshExpiresIn,
      scope: args.scope
    };
  }

  /** Build the user identity JWT maestro verifies: RS256, `email` + `sub` + `iss` + `aud` + `exp`/`iat`,
   *  plus an optional coarse `roles` array (RQ-0005) — additive; consumers that don't read it ignore it —
   *  and, with the record wired, `prn` + `principal_kind: human` (ADR-0022), additive likewise. */
  async function signUserAccessToken(args: {
    jti: string;
    audience: string;
    email?: string;
    sub: string;
    prn?: string;
    scope: string[];
    roles?: string[];
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<string> {
    const keyPair = await getActiveKeyPair();
    const privateKey = await importPKCS8(keyPair.privateKeyPem, 'RS256');

    const payload: Record<string, unknown> = {};
    if (args.email) payload.email = args.email;
    if (args.scope.length) payload.scope = args.scope.join(' ');
    if (args.roles && args.roles.length) payload.roles = args.roles;
    if (args.prn) {
      payload.prn = args.prn;
      payload.principal_kind = 'human';
    }

    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: keyPair.kid, typ: 'JWT' })
      .setIssuer(CONFIG.auth.jwtIssuer)
      .setAudience(args.audience)
      .setSubject(args.sub)
      .setJti(args.jti)
      .setIssuedAt(Math.floor(args.issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(args.expiresAt.getTime() / 1000))
      .sign(privateKey);
  }

  return {
    issueClientCredentialsToken,
    startAuthorization,
    completeLocalLogin,
    getLoginContext,
    handleGoogleCallback,
    issueAuthorizationCodeToken,
    issuePasswordToken,
    refreshUserToken,
    revokeUserToken
  };
}

/** Resolve the application a credential belongs to (ADR-0020). Required for user grants — it supplies the
 *  entitlement key and the default token audience. */
async function requireApplication(store: Store, client: { applicationId?: string }): Promise<ApplicationDocument> {
  if (!client.applicationId) throw new UnauthorizedClientError('Client is not part of an application');
  const application = await store.applications.get(client.applicationId);
  if (!application) throw new UnauthorizedClientError('Client application not found');
  return application;
}

/** The token `aud`: a credential-level override wins, else the application default, else the
 *  service-wide default (ADR-0020). */
function effectiveAudience(client: { audience?: string }, application: { audience?: string } | null): string | undefined {
  return client.audience ?? application?.audience ?? undefined;
}

async function enforceRateLimit(store: Store, issuedAt: Date, maxPerMinute: number) {
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
    return;
  }
  const windowStart = new Date(issuedAt.getTime() - 60 * 1000);
  const count = await store.tokens.countIssuedSince('access', windowStart);

  if (count >= maxPerMinute) {
    throw new RateLimitExceededError(60);
  }
}
