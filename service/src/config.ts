import dotenv from 'dotenv';

dotenv.config();

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOrigins = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const CONFIG = {
  environment: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 7305),
  mongo: {
    uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017',
    dbName: process.env.MONGO_DB_NAME ?? 'identity-service'
  },
  auth: {
    sessionTtlMinutes: toNumber(process.env.SESSION_TTL_MINUTES, 15),
    jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
    jwtIssuer: process.env.AUTH_JWT_ISSUER ?? 'identity-service',
    jwtAudience: process.env.AUTH_JWT_AUDIENCE ?? 'identity-service-clients',
    // Local-credential IdP (RQ-0002): password policy + brute-force lockout.
    password: {
      minLength: toNumber(process.env.AUTH_PASSWORD_MIN_LENGTH, 10),
      maxFailedAttempts: toNumber(process.env.AUTH_PASSWORD_MAX_ATTEMPTS, 5),
      lockoutMinutes: toNumber(process.env.AUTH_PASSWORD_LOCKOUT_MINUTES, 15),
      // Per-tenant self-service registration rate limit (abuse guard on the public endpoint).
      registrationsPerMinute: toNumber(process.env.AUTH_REGISTRATIONS_PER_MINUTE, 20)
    }
  },
  oauth: {
    accessTokenTtlSec: toNumber(process.env.OAUTH_ACCESS_TOKEN_TTL_SEC, 15 * 60),
    refreshTokenTtlSec: toNumber(process.env.OAUTH_REFRESH_TOKEN_TTL_SEC, 30 * 24 * 60 * 60),
    defaultClientCredentialsScopes: parseOrigins(process.env.OAUTH_CLIENT_CREDENTIALS_SCOPE),
    // The short-lived authorization record (state + PKCE challenge + nonce, then the minted code)
    // that ties the Google redirect leg to the consumer's token exchange. Kept small.
    authorizationTtlSec: toNumber(process.env.OAUTH_AUTHORIZATION_TTL_SEC, 10 * 60),
    key: {
      encryptionPassphrase: process.env.OAUTH_KEY_PASSPHRASE ?? '',
      rotationIntervalHours: toNumber(process.env.OAUTH_KEY_ROTATION_HOURS, 24 * 30)
    },
    tenantDefaults: {
      maxClients: toNumber(process.env.OAUTH_TENANT_MAX_CLIENTS, 50),
      maxAccessTokensPerMinute: toNumber(process.env.OAUTH_TENANT_MAX_TOKENS_PER_MINUTE, 200),
      maxRefreshTokens: toNumber(process.env.OAUTH_TENANT_MAX_REFRESH_TOKENS, 10_000)
    }
  },
  // Management plane (ADR-0007): the authenticated admin API (/admin/v1) + MCP server. Admin principals
  // are OAuth client-credentials clients whose token carries the `requiredScope` below (default `admin`),
  // verified against this service's own JWKS. `enabled` lets a deployment turn the whole surface off; on
  // ds1 it should be bound off the public tunnel (network-restricted) — see ADR-0007.
  admin: {
    enabled: (process.env.ADMIN_API_ENABLED ?? 'true') !== 'false',
    basePath: process.env.ADMIN_API_BASE_PATH ?? '/admin/v1',
    // The scope a client-credentials token must carry to reach the management plane. Granular
    // per-area scopes (`admin:tenants`, `admin:users`, …) also satisfy their own routes for
    // least-privilege agents; this superscope satisfies all of them.
    requiredScope: process.env.ADMIN_API_SCOPE ?? 'admin',
    // Per-actor operator login (ADR-0010): a USER identity token (`sub`, no `cid`) whose `roles` claim
    // (RQ-0005) contains one of these roles is accepted as an operator principal and mapped to the
    // `requiredScope` superscope. This is what lets the admin console attribute actions to a human
    // instead of one shared machine client. Empty list → no operator-by-role path (machine tokens only).
    operatorRoles: (process.env.ADMIN_OPERATOR_ROLES ?? 'platform_admin')
      .split(',').map((r) => r.trim()).filter(Boolean)
  },
  // Remote MCP transport (ADR-0009 Phase 1): the management MCP server exposed in-process over MCP
  // Streamable HTTP as an OAuth-protected resource, so agents connect with a bearer admin token instead
  // of SSH+stdio. Same admin-auth + audit path as /admin/v1 and the stdio server. `resourceUrl` is the
  // canonical resource identifier advertised in the protected-resource metadata (Phase 1: this origin +
  // basePath; Phase 2 moves it to the dedicated auth-mcp.fps4.nl origin).
  mcp: {
    enabled: (process.env.MCP_HTTP_ENABLED ?? 'true') !== 'false',
    basePath: process.env.MCP_HTTP_BASE_PATH ?? '/mcp',
    resourceUrl: process.env.MCP_RESOURCE_URL ?? `${process.env.AUTH_JWT_ISSUER ?? 'http://localhost:7305'}/mcp`,
    // Audience-binding (RFC 8707, ADR-0009 Phase 2): require the presented token's `aud` to include the
    // MCP resource, so a token minted for another resource (e.g. a generic admin token) can't be replayed
    // here. Clients obtain a bound token by passing `resource=<resourceUrl>` to /oauth2/token. Default on;
    // set MCP_REQUIRE_AUDIENCE=false to soft-launch before clients are updated.
    requireAudience: (process.env.MCP_REQUIRE_AUDIENCE ?? 'true') !== 'false'
  },
  // Upstream Google OIDC app (RQ-0001). A single Google app per deployment federates user login;
  // the issued user token's `aud` is still per-consumer (oauth_clients.audience), not Google's.
  // Endpoints are overridable so tests can inject a stub IdP with no network.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    issuer: process.env.GOOGLE_ISSUER ?? 'https://accounts.google.com',
    authorizationEndpoint: process.env.GOOGLE_AUTHORIZATION_ENDPOINT ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: process.env.GOOGLE_TOKEN_ENDPOINT ?? 'https://oauth2.googleapis.com/token',
    jwksUri: process.env.GOOGLE_JWKS_URI ?? 'https://www.googleapis.com/oauth2/v3/certs',
    // Where Google redirects back to this service; must be a registered redirect URI on the Google app.
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? ''
  },
  cors: {
    staticOrigins: parseOrigins(process.env.CORS_ORIGINS),
    allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']
  },
  corsRefreshIntervalMs: toNumber(process.env.TENANT_CORS_REFRESH_INTERVAL_MS, 5 * 60 * 1000),
  // Outbound fleet-monitoring to maestro (managed-product platform: heartbeat US-0070 + telemetry
  // US-0076). Reports under the "identity-service" product / ds1 deployment that maestro's register already
  // declares (runtime@identity-service.fps4.nl). Stays fully INERT when apiUrl is empty (local dev / tests /
  // CI build) — nothing is sent. The runtime JWT is self-minted via this service's own client_credentials.
  maestro: {
    apiUrl: process.env.MAESTRO_API_URL ?? '',
    productId: process.env.MAESTRO_PRODUCT_ID ?? 'identity-service',
    deploymentId: process.env.MAESTRO_DEPLOYMENT_ID ?? 'ds1',
    runtimeClientId: process.env.MAESTRO_RUNTIME_CLIENT_ID ?? 'identity-service-ds1-runtime',
    runtimeClientSecret: process.env.MAESTRO_RUNTIME_CLIENT_SECRET ?? '',
    emitIntervalMs: toNumber(process.env.MAESTRO_EMIT_INTERVAL_MS, 60_000)
  }
} as const;

export default CONFIG;
