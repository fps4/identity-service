/**
 * MCP **Streamable HTTP** transport (ADR-0009 Phase 1) — the network-reachable, OAuth-authenticated face
 * of the management MCP server, over the SAME transport-agnostic core (`./handler.ts`) as the stdio
 * transport. An agent connects to this endpoint with a bearer admin token minted from this service's own
 * `/oauth2/token` (`client_credentials`) — no SSH, no shell account on a production host.
 *
 * This is the MCP protected *resource*. identity-service is its authorization server (it issues + verifies
 * the token). The MCP authorization flow is bootstrapped by two discovery documents served by the app:
 *   - `/.well-known/oauth-protected-resource` (RFC 9728) — points the client at the authorization server;
 *   - `/.well-known/oauth-authorization-server` (RFC 8414) — the AS metadata (token endpoint, JWKS, …).
 * A request without a usable token gets a `401`/`403` with a `WWW-Authenticate: Bearer resource_metadata`
 * challenge so a standard MCP client can discover the AS and obtain a token.
 *
 * Scope: authentication is "any valid admin-plane principal" (a machine token with an admin scope, or an
 * operator token — ADR-0010); per-TOOL authorization is enforced inside `handleRpc` exactly as on stdio
 * and the HTTP admin API. Phase 2 (ADR-0009) adds the dedicated origin, audience-binding, DPoP/mTLS,
 * step-up, and dynamic client registration.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { decodeJwt } from 'jose';
import { verifyAdminToken, principalHasScope, AdminTokenError, ADMIN_SCOPES, type AdminPrincipal } from '../core/admin-auth.js';
import { CONFIG } from '../config.js';
import logger from '../utils/logger.js';
import { handleRpc } from './handler.js';

const ADMIN_AREA_SCOPES = Object.values(ADMIN_SCOPES);

/** True for any admin-plane principal: the `admin` superscope, or any `admin:<area>` scope, or an operator. */
function isAdminPlanePrincipal(principal: AdminPrincipal): boolean {
  return ADMIN_AREA_SCOPES.some((s) => principalHasScope(principal, s));
}

/**
 * Audience-binding (RFC 8707, ADR-0009 Phase 2): the token must be bound to THIS MCP resource, so a
 * generic admin token (or one minted for another resource) cannot be replayed here. The client obtains a
 * bound token by passing `resource=<resourceUrl>` to /oauth2/token. Disabled by `MCP_REQUIRE_AUDIENCE=false`.
 */
function hasResourceAudience(token: string): boolean {
  if (!CONFIG.mcp.requireAudience) return true;
  try {
    const aud = decodeJwt(token).aud; // signature already verified by verifyAdminToken
    const auds = Array.isArray(aud) ? aud : aud ? [aud] : [];
    return auds.includes(CONFIG.mcp.resourceUrl);
  } catch {
    return false;
  }
}

/** RFC 9728 protected-resource metadata: tells an MCP client which authorization server guards this resource. */
export function protectedResourceMetadata() {
  return {
    resource: CONFIG.mcp.resourceUrl,
    authorization_servers: [CONFIG.auth.jwtIssuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [CONFIG.admin.requiredScope, ...ADMIN_AREA_SCOPES]
  };
}

/** RFC 8414 authorization-server metadata for this service (it is the AS for its own MCP resource). */
export function authorizationServerMetadata() {
  const iss = CONFIG.auth.jwtIssuer;
  return {
    issuer: iss,
    token_endpoint: `${iss}/oauth2/token`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [CONFIG.admin.requiredScope, ...ADMIN_AREA_SCOPES]
  };
}

/** The absolute URL of the protected-resource metadata, for the `WWW-Authenticate` challenge (RFC 9728). */
function resourceMetadataUrl(): string {
  try {
    return `${new URL(CONFIG.mcp.resourceUrl).origin}/.well-known/oauth-protected-resource`;
  } catch {
    return '/.well-known/oauth-protected-resource';
  }
}

function challenge(res: Response, status: number, error: string, description: string): void {
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadataUrl()}", error="${error}", error_description="${description}"`
  );
  res.status(status).json({ error, error_description: description });
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Authenticate the MCP caller as an admin-plane principal, or emit a discovery-bearing challenge. */
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (!token) return challenge(res, 401, 'unauthorized', 'Bearer admin token required');
  try {
    const principal = await verifyAdminToken(token);
    if (!hasResourceAudience(token)) {
      return challenge(res, 401, 'invalid_token', `Token audience must include the MCP resource ${CONFIG.mcp.resourceUrl} (request it via a resource parameter at /oauth2/token)`);
    }
    if (!isAdminPlanePrincipal(principal)) return challenge(res, 403, 'insufficient_scope', 'Token lacks an admin scope');
    (req as Request & { mcpPrincipal?: AdminPrincipal }).mcpPrincipal = principal;
    next();
  } catch (err) {
    if (err instanceof AdminTokenError) {
      return err.reason === 'forbidden'
        ? challenge(res, 403, 'insufficient_scope', err.message)
        : challenge(res, 401, 'unauthorized', err.message);
    }
    logger.warn({ err }, 'MCP token verification failed');
    return challenge(res, 401, 'unauthorized', 'Invalid or expired admin token');
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

/**
 * The MCP Streamable HTTP endpoint router (mount at `CONFIG.mcp.basePath`). `POST` carries a JSON-RPC
 * request and returns the JSON-RPC response (or `202` for a notification). `GET` would open a
 * server→client SSE stream — this server initiates no messages, so it returns `405`.
 */
export function createMcpRouter(): Router {
  const router = Router();

  router.post('/', authenticate, async (req, res) => {
    const principal = (req as Request & { mcpPrincipal?: AdminPrincipal }).mcpPrincipal!;
    const body = req.body;
    // MVP: a single JSON-RPC message per POST (batch arrays are optional in the spec and not needed here).
    if (Array.isArray(body)) return void res.status(400).json(rpcError(null, -32600, 'Batch requests are not supported'));
    if (!body || typeof body !== 'object' || typeof (body as { method?: unknown }).method !== 'string') {
      return void res.status(400).json(rpcError((body as { id?: unknown })?.id ?? null, -32600, 'Invalid JSON-RPC request'));
    }
    const response = await handleRpc(body, principal);
    if (!response) return void res.status(202).end(); // notification — accepted, no body
    res.json(response);
  });

  router.get('/', authenticate, (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed', error_description: 'This MCP endpoint offers no server-initiated SSE stream; use POST.' });
  });

  return router;
}
