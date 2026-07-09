/**
 * Transport-agnostic MCP core (ADR-0009 Phase 0). The JSON-RPC dispatch, the tool catalogue, the
 * `principalHasScope` gate, and the audit write — everything EXCEPT how bytes get on and off the wire —
 * live here, over the SAME service layer (`adminService`), admin-auth model, and audit trail as ADR-0007.
 *
 * A transport (stdio today — `./server.ts`; Streamable HTTP next — ADR-0009 Phase 1) is now just: parse a
 * JSON-RPC message, hand it to {@link handleRpc} with the verified principal, and write back the response
 * it returns (or nothing, for a notification). No tool logic is duplicated per transport.
 *
 * Scope (ADR-0011): the MCP is the *agent* face on the IMPERATIVE side — read + operational only. It does
 * NOT provision structure (no `onboard_tenant`/`create_client`/`delete_client`); those stay on the HTTP
 * admin API for break-glass. Users/credentials/keys/invites are runtime state owned by the DB and stay.
 */
import { adminService } from '../container.js';
import { principalHasScope, ADMIN_SCOPES, type AdminPrincipal } from '../core/admin-auth.js';
import { getMasterConnection } from '../utils/db.js';
import { makeModels } from '../models/index.js';
import logger from '../utils/logger.js';

export const SERVER_INFO = { name: 'identity-service-admin', version: '0.1.0' };
export const DEFAULT_PROTOCOL = '2024-11-05';

export interface ToolDef {
  name: string;
  description: string;
  areaScope: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: any;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const obj = (props: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: true });
const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };

export const TOOLS: ToolDef[] = [
  // Structural provisioning (create_client / delete_client) is intentionally NOT exposed here — OAuth
  // clients are declarative, seeded from git config (ADR-0011, ADR-0018). They remain on the HTTP admin
  // API for break-glass. The MCP keeps only read + operational tools below.
  {
    name: 'rotate_client_secret',
    description: 'Rotate an existing client secret (operational credential rotation). Returns the new secret ONCE.',
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({ clientId: str }, ['clientId']),
    handler: (a) => adminService.rotateClientSecret(a.clientId)
  },
  {
    name: 'create_user',
    description: 'Create a local-credential user.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, password: str, roles: strArr }, ['email', 'password']),
    handler: (a) => adminService.createUser(a)
  },
  {
    name: 'reset_user_password',
    description: "Reset a user's password (also clears any brute-force lockout).",
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, password: str }, ['email', 'password']),
    handler: async (a) => { await adminService.resetUserPassword(a.email, a.password); return { ok: true }; }
  },
  {
    name: 'set_user_status',
    description: "Set a user's status to 'active' or 'disabled'.",
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, status: { type: 'string', enum: ['active', 'disabled'] } }, ['email', 'status']),
    handler: async (a) => { await adminService.setUserStatus(a.email, a.status); return { ok: true }; }
  },
  {
    name: 'unlock_user',
    description: 'Clear a brute-force lockout and reactivate a user.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str }, ['email']),
    handler: async (a) => { await adminService.unlockUser(a.email); return { ok: true }; }
  },
  // Invites (RQ-0013) are runtime user-onboarding state — operational, not structural — so they
  // belong on the MCP surface alongside the other user tools (ADR-0011).
  {
    name: 'create_invite',
    description: 'Mint a registration invite (RQ-0013). Returns the code ONCE — only its digest is stored. Optional: bind to an email, stamp roles, allow multiple uses, set expiry in hours.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({
      email: str,
      roles: strArr,
      maxUses: { type: 'number' },
      expiresInHours: { type: 'number' },
      note: str
    }, []),
    handler: (a) => adminService.createInvite(a)
  },
  {
    name: 'list_invites',
    description: 'List the deployment\'s invites with derived status (pending/redeemed/expired/revoked). Codes are never shown.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({}),
    handler: () => adminService.listInvites()
  },
  {
    name: 'revoke_invite',
    description: 'Revoke an invite so no further redemptions succeed.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ inviteId: str }, ['inviteId']),
    handler: (a) => adminService.revokeInvite(a.inviteId)
  },
  {
    name: 'rotate_signing_key',
    description: 'Rotate the active RS256 signing key (the previous key stays published in the JWKS).',
    areaScope: ADMIN_SCOPES.keys,
    inputSchema: obj({}),
    handler: () => adminService.rotateKey()
  },
  {
    name: 'get_stats',
    description: 'Aggregate counts for clients, users, tokens, and keys.',
    areaScope: ADMIN_SCOPES.stats,
    inputSchema: obj({}),
    handler: () => adminService.getStats()
  }
];

/** Append an MCP action to the same append-only audit trail as the HTTP admin API. Best-effort. */
export async function writeAudit(principal: AdminPrincipal, action: string, ok: boolean, meta?: Record<string, unknown>): Promise<void> {
  try {
    const models = makeModels(await getMasterConnection());
    await models.AuditLog.create({
      at: new Date(),
      principalClientId: principal.clientId,
      principalSubject: principal.subject,
      action: `mcp:${action}`,
      method: 'MCP',
      path: action,
      status: ok ? 200 : 500,
      meta
    });
  } catch (err) {
    logger.error({ err, action }, 'failed to write MCP audit log');
  }
}

/**
 * Injectable collaborators. Defaults are the real tool catalogue + the Mongo-backed audit writer; tests
 * override them to exercise the dispatch/gate logic without a database.
 */
export interface HandlerDeps {
  tools: ToolDef[];
  writeAudit: (principal: AdminPrincipal, action: string, ok: boolean, meta?: Record<string, unknown>) => Promise<void>;
}
export const defaultDeps: HandlerDeps = { tools: TOOLS, writeAudit };

const ok = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleToolCall(id: unknown, principal: AdminPrincipal, params: any, deps: HandlerDeps): Promise<JsonRpcResponse> {
  const tool = deps.tools.find((t) => t.name === params?.name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);

  // Same scope gate as the HTTP route — least-privilege agents only reach their granted areas.
  if (!principalHasScope(principal, tool.areaScope)) {
    void deps.writeAudit(principal, tool.name, false, { denied: 'insufficient_scope' });
    return ok(id, { content: [{ type: 'text', text: `Forbidden: requires scope for ${tool.areaScope}` }], isError: true });
  }

  try {
    const result = await tool.handler(params?.arguments ?? {});
    void deps.writeAudit(principal, tool.name, true);
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    const message = (err as { message?: string })?.message ?? 'tool failed';
    void deps.writeAudit(principal, tool.name, false, { error: message });
    return ok(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
  }
}

/**
 * Dispatch one JSON-RPC message and return the response to send back, or `null` for a notification (no
 * reply). Pure with respect to the transport: it never touches stdin/stdout or an HTTP socket.
 */
export async function handleRpc(msg: JsonRpcRequest, principal: AdminPrincipal, deps: HandlerDeps = defaultDeps): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case 'notifications/initialized':
      return null; // notification, no response
    case 'tools/list':
      return ok(id, { tools: deps.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call':
      return handleToolCall(id, principal, params, deps);
    case 'ping':
      return ok(id, {});
    default:
      return id !== undefined ? rpcError(id, -32601, `Method not found: ${method}`) : null;
  }
}
