import 'server-only';
import { callerToken } from '@/lib/identity';

/**
 * Server-only client for the identity-service management API (ADR-0007, ADR-0010). The console is a thin
 * server-side proxy over /admin/v1 — no token ever reaches the browser.
 *
 * Per-actor (ADR-0010): each request forwards the signed-in OPERATOR's token (read from the session
 * cookie via lib/identity), so the management plane attributes the action to the human. Break-glass: if
 * there is no operator session, fall back to the static `ADMIN_API_TOKEN` (bootstrap / non-interactive),
 * which authenticates as a machine client and is NOT per-actor.
 */
const BASE = process.env.ADMIN_API_URL ?? 'http://localhost:7305/admin/v1';
const BREAK_GLASS_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = (await callerToken()) ?? BREAK_GLASS_TOKEN;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    cache: 'no-store'
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(body?.error_description ?? `Request failed (${res.status})`, res.status, body?.error);
  }
  return body as T;
}

export interface Stats {
  clients: { total: number };
  users: { total: number; locked: number; disabled: number };
  assignments: { active: number };
  tokens: { accessLastHour: number; accessLastDay: number; activeRefresh: number };
  keys: { active: number };
  at: string;
}
export interface Invite { _id: string; clientId: string; email?: string | null; roles?: string[]; maxUses: number; usedCount: number; expiresAt: string; note?: string; status: 'pending' | 'redeemed' | 'expired' | 'revoked'; createdAt?: string; createdBy?: string }
/** A role in an application's own role catalogue (ADR-0019). Roles are per-application now. */
export interface AppRole { key: string; name?: string; description?: string }
export interface Client { _id: string; name: string; grantTypes: string[]; scopes: string[]; audience?: string; isConfidential?: boolean; redirectUris?: string[]; roles?: AppRole[] }
export interface FederatedIdentity { provider: string; subject: string; email?: string; emailVerified?: boolean; linkedAt?: string }
export interface User { _id: string; email: string; status: string; emailVerified?: boolean; lockedUntil?: string | null; failedAttempts?: number; identities?: FederatedIdentity[] }
/** One user's access to one application (ADR-0019): the entitlement + app-scoped roles. */
export interface Assignment { clientId: string; clientName?: string; status: 'active' | 'suspended'; roles: string[] }
/** A member of an application (ADR-0019): a user assigned to it, with their app-scoped roles. */
export interface Member { userId: string; email?: string; userStatus?: string; status: 'active' | 'suspended'; roles: string[] }
export interface AuditEntry { _id: string; at: string; action: string; principalClientId?: string; targetId?: string; status: number }

export const api = {
  getStats: () => request<Stats>('/stats'),
  listClients: () => request<{ clients: Client[] }>('/clients').then((r) => r.clients),
  listUsers: () => request<{ users: User[] }>('/users').then((r) => r.users),
  recentAudit: (limit = 25) => request<{ entries: AuditEntry[] }>(`/audit?limit=${limit}`).then((r) => r.entries),

  createClient: (body: Record<string, unknown>) => request<{ clientId: string; secret: string }>('/clients', { method: 'POST', body: JSON.stringify(body) }),
  rotateClientSecret: (clientId: string) => request<{ clientId: string; secret: string }>(`/clients/${clientId}/rotate-secret`, { method: 'POST' }),
  deleteClient: (clientId: string) => request<{ clientId: string; deleted: true }>(`/clients/${clientId}`, { method: 'DELETE' }),

  // Per-application role catalogue + membership (ADR-0019).
  getClientRoles: (clientId: string) => request<{ roles: AppRole[] }>(`/clients/${clientId}/roles`).then((r) => r.roles),
  setClientRoles: (clientId: string, roles: AppRole[]) => request<{ roles: AppRole[] }>(`/clients/${clientId}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) }).then((r) => r.roles),
  listClientMembers: (clientId: string) => request<{ members: Member[] }>(`/clients/${clientId}/members`).then((r) => r.members),

  // Per-user assignments (entitlement + app-scoped roles) (ADR-0019).
  assignUser: (body: { email: string; clientId: string; roles?: string[] }) => request<{ email: string; clientId: string; roles: string[]; status: string }>('/assignments', { method: 'POST', body: JSON.stringify(body) }),
  updateAssignment: (body: { email: string; clientId: string; roles?: string[]; status?: 'active' | 'suspended' }) => request<{ email: string; clientId: string; roles: string[]; status: string }>('/assignments/update', { method: 'POST', body: JSON.stringify(body) }),
  revokeAssignment: (body: { email: string; clientId: string }) => request<{ email: string; clientId: string; revoked: true }>('/assignments/revoke', { method: 'POST', body: JSON.stringify(body) }),
  listUserAssignments: (email: string) => request<{ assignments: Assignment[] }>(`/assignments?email=${encodeURIComponent(email)}`).then((r) => r.assignments),

  createUser: (body: Record<string, unknown>) => request<{ id: string; email: string }>('/users', { method: 'POST', body: JSON.stringify(body) }),
  resetPassword: (body: Record<string, unknown>) => request<{ ok: boolean }>('/users/reset-password', { method: 'POST', body: JSON.stringify(body) }),
  setUserStatus: (body: Record<string, unknown>) => request<{ ok: boolean }>('/users/status', { method: 'POST', body: JSON.stringify(body) }),
  unlockUser: (body: Record<string, unknown>) => request<{ ok: boolean }>('/users/unlock', { method: 'POST', body: JSON.stringify(body) }),
  deleteUser: (body: Record<string, unknown>) => request<{ email: string; deleted: true }>('/users/delete', { method: 'POST', body: JSON.stringify(body) }),
  linkIdentity: (body: Record<string, unknown>) => request<{ email: string; provider: string; subject: string; linked: true }>('/users/link-identity', { method: 'POST', body: JSON.stringify(body) }),
  unlinkIdentity: (body: Record<string, unknown>) => request<{ email: string; provider: string; subject: string; unlinked: true }>('/users/unlink-identity', { method: 'POST', body: JSON.stringify(body) }),
  listInvites: () => request<{ invites: Invite[] }>('/invites').then((r) => r.invites),
  createInvite: (body: Record<string, unknown>) => request<{ inviteId: string; code: string; expiresAt: string }>('/invites', { method: 'POST', body: JSON.stringify(body) }),
  revokeInvite: (inviteId: string) => request<{ inviteId: string; revoked: true }>(`/invites/${inviteId}/revoke`, { method: 'POST' }),
  rotateKey: () => request<{ kid: string }>('/keys/rotate', { method: 'POST' })
};
