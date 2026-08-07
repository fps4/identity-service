/**
 * Transport-agnostic MCP core (ADR-0009 Phase 0). The JSON-RPC dispatch, the tool catalogue, the
 * `principalHasScope` gate, and the audit write — everything EXCEPT how bytes get on and off the wire —
 * live here, over the SAME service layer (`adminService`), admin-auth model, and audit trail as ADR-0007.
 *
 * A transport (stdio today — `./server.ts`; Streamable HTTP next — ADR-0009 Phase 1) is now just: parse a
 * JSON-RPC message, hand it to {@link handleRpc} with the verified principal, and write back the response
 * it returns (or nothing, for a notification). No tool logic is duplicated per transport.
 *
 * Scope (ADR-0011, amended by ADR-0021): the MCP is the *agent* face on the IMPERATIVE side. It carries
 * read + operational tools AND the two registration tools — `create_application` / `create_client` —
 * because identity-service is where a credential's secret is MINTED. Destructive structural tools
 * (`delete_client`, `delete_application`) stay HTTP-only for break-glass: least-privilege still applies
 * to removal, which registration does not need. Users/credentials/keys/invites are DB-owned runtime state.
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
const roleCatalogue = { type: 'array', items: { type: 'object', properties: { key: str, name: str, description: str }, required: ['key'] } };

export const TOOLS: ToolDef[] = [
  // REGISTRATION (ADR-0021). A credential's secret is minted here and returned ONCE, so registering one
  // has to happen on a write surface — a seed file can only ever carry a secret that some *other* store
  // already owns, which is the coupling ADR-0021 removes. Deletion stays HTTP-only: least-privilege
  // still argues against handing an agent a way to remove a live credential.
  {
    name: 'create_application',
    description: 'Register a product as an application (ADR-0020): its audience, role catalogue, and protected-resource registry. Structure only — add its credentials with create_client.',
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({ id: str, name: str, audience: str, roles: roleCatalogue, resources: strArr }, ['name']),
    handler: (a) => adminService.createApplication(a)
  },
  {
    name: 'create_client',
    description: 'Register a credential under an application. identity-service MINTS the secret and returns it ONCE — only the hash is stored, and it cannot be read back. Copy it straight into the CONSUMING repo\'s secret store; never put it in a seed file.',
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({
      applicationId: str, id: str, name: str, grantTypes: strArr, redirectUris: strArr,
      scopes: strArr, audience: str, subject: str,
      isConfidential: { type: 'boolean' }, claims: { type: 'object' }
    }, ['applicationId', 'name', 'grantTypes']),
    handler: (a) => adminService.createClient(a)
  },
  {
    name: 'rotate_client_secret',
    description: 'Rotate an existing client secret (operational credential rotation). Returns the new secret ONCE.',
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({ clientId: str }, ['clientId']),
    handler: (a) => adminService.rotateClientSecret(a.clientId)
  },
  {
    name: 'create_user',
    description: 'Create a local-credential user. Grant app access separately with assign_user (roles are per-application — ADR-0019).',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, password: str }, ['email', 'password']),
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
  // Applications + assignments (ADR-0019/0020): the product registration, its role catalogue, and a
  // user's entitlement to it. Operational read/user-access state — belongs on the MCP surface.
  {
    name: 'list_applications',
    description: 'List the applications (products) with their audience and role catalogues.',
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({}),
    handler: () => adminService.listApplications()
  },
  {
    name: 'assign_user',
    description: "Assign a user to an application with app-scoped roles (ADR-0020). Roles must be in the application's role catalogue. Idempotent — re-assigning updates the roles.",
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, applicationId: str, roles: strArr }, ['email', 'applicationId']),
    handler: (a) => adminService.assignUser(a)
  },
  {
    name: 'update_assignment',
    description: "Change a user's app-scoped roles and/or suspend/reactivate their assignment to an application.",
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, applicationId: str, roles: strArr, status: { type: 'string', enum: ['active', 'suspended'] } }, ['email', 'applicationId']),
    handler: (a) => adminService.updateAssignment(a.email, a.applicationId, { roles: a.roles, status: a.status })
  },
  {
    name: 'revoke_assignment',
    description: "Revoke a user's entitlement to an application (they can no longer obtain a token for it).",
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str, applicationId: str }, ['email', 'applicationId']),
    handler: (a) => adminService.revokeAssignment(a.email, a.applicationId)
  },
  {
    name: 'list_app_members',
    description: 'List the users assigned to an application, with their app-scoped roles.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ applicationId: str }, ['applicationId']),
    handler: (a) => adminService.listApplicationMembers(a.applicationId)
  },
  {
    name: 'list_user_assignments',
    description: 'List the applications a user is assigned to, with their app-scoped roles.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({ email: str }, ['email']),
    handler: (a) => adminService.listUserAssignments(a.email)
  },
  {
    name: 'set_application_roles',
    description: "Replace an application's role catalogue (ADR-0020) — the roles assignments may grant for it.",
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({ applicationId: str, roles: roleCatalogue }, ['applicationId', 'roles']),
    handler: (a) => adminService.setApplicationRoles(a.applicationId, a.roles)
  },
  {
    name: 'set_application_resources',
    description: "Replace an application's protected-resource registry (ADR-0009 Phase 2) — the absolute RFC 8707 `resource` URIs, such as its MCP endpoint, that its credentials may bind a token's `aud` to. A resource not listed here is refused with invalid_target.",
    areaScope: ADMIN_SCOPES.clients,
    inputSchema: obj({ applicationId: str, resources: strArr }, ['applicationId', 'resources']),
    handler: (a) => adminService.setApplicationResources(a.applicationId, a.resources)
  },
  // Invites (RQ-0013) are runtime user-onboarding state — operational, not structural — so they
  // belong on the MCP surface alongside the other user tools (ADR-0011).
  {
    name: 'create_invite',
    description: 'Mint a registration invite (RQ-0013, ADR-0020). Entitles the redeemer to an application (applicationId, required) with app-scoped roles. Returns the code ONCE. Optional: bind to an email, allow multiple uses, set expiry in hours.',
    areaScope: ADMIN_SCOPES.users,
    inputSchema: obj({
      applicationId: str,
      email: str,
      roles: strArr,
      maxUses: { type: 'number' },
      expiresInHours: { type: 'number' },
      note: str
    }, ['applicationId']),
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
    description: 'Aggregate counts for clients, users, assignments, tokens, and keys.',
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
