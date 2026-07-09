'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import type { AppRole, Assignment, Client, Member } from '@/lib/api';

export interface ActionResult {
  ok: boolean;
  message?: string;
  /** Show-once material (a client secret, an invite code) — surfaced in a copyable dialog, never persisted. */
  secret?: string;
  secretHint?: string;
}

const run = async (fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  try { return await fn(); }
  catch (e) {
    const msg = e instanceof ApiError ? e.message : 'Request failed';
    return { ok: false, message: msg };
  }
};

const s = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const list = (fd: FormData, k: string) => s(fd, k).split(',').map((x) => x.trim()).filter(Boolean);
/** Read a multi-valued field (repeated inputs / checkboxes) — e.g. app-scoped role selections. */
const multi = (fd: FormData, k: string) => fd.getAll(k).map((x) => String(x).trim()).filter(Boolean);

/** Register a credential (OAuth client) under an application (ADR-0020). applicationId is required. */
export async function createClient(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const res = await api.createClient({
      applicationId: s(fd, 'applicationId'),
      name: s(fd, 'name'),
      grantTypes: list(fd, 'grantTypes'),
      scopes: list(fd, 'scopes'),
      redirectUris: list(fd, 'redirectUris'),
      audience: s(fd, 'audience') || undefined,
      subject: s(fd, 'subject') || undefined,
      isConfidential: s(fd, 'isConfidential') !== 'false'
    });
    revalidatePath('/clients');
    revalidatePath('/applications');
    return { ok: true, message: `Credential ${res.clientId} created`, secret: res.secret };
  });
}

export async function rotateClientSecret(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const res = await api.rotateClientSecret(s(fd, 'clientId'));
    revalidatePath('/clients');
    revalidatePath('/applications');
    return { ok: true, message: 'Secret rotated', secret: res.secret };
  });
}

export async function deleteClient(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.deleteClient(s(fd, 'clientId'));
    revalidatePath('/clients');
    revalidatePath('/applications');
    return { ok: true, message: 'Credential deleted' };
  });
}

// --- Applications (ADR-0020): the top-level product ---

/** Create an application. Its role-catalogue keys can be seeded from a comma-separated list. */
export async function createApplication(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const roles: AppRole[] = list(fd, 'roles').map((key) => ({ key }));
    const res = await api.createApplication({
      name: s(fd, 'name'),
      audience: s(fd, 'audience') || undefined,
      ...(roles.length ? { roles } : {})
    });
    revalidatePath('/applications');
    return { ok: true, message: `Application ${res.applicationId} created` };
  });
}

/** Delete an application (409 if it still has credentials). */
export async function deleteApplication(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.deleteApplication(s(fd, 'applicationId'));
    revalidatePath('/applications');
    return { ok: true, message: 'Application deleted' };
  });
}

export async function createUser(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    // ADR-0019: users no longer carry deployment-wide roles — access is granted per-application via assignments.
    await api.createUser({ email: s(fd, 'email'), password: s(fd, 'password') });
    revalidatePath('/users');
    return { ok: true, message: 'User created' };
  });
}

export async function resetPassword(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.resetPassword({ email: s(fd, 'email'), password: s(fd, 'password') });
    return { ok: true, message: 'Password reset' };
  });
}

export async function setUserStatus(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.setUserStatus({ email: s(fd, 'email'), status: s(fd, 'status') });
    revalidatePath('/users');
    return { ok: true, message: `User ${s(fd, 'status')}` };
  });
}

export async function unlockUser(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.unlockUser({ email: s(fd, 'email') });
    revalidatePath('/users');
    return { ok: true, message: 'User unlocked' };
  });
}

export async function deleteUser(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.deleteUser({ email: s(fd, 'email') });
    revalidatePath('/users');
    return { ok: true, message: 'User deleted' };
  });
}

/** Link a federated identity (Google) onto an existing user (RQ-0011). The operator counterpart to the
 *  automatic link-on-verified-email at login, for the ambiguous cases the system won't merge itself. */
export async function linkIdentity(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.linkIdentity({
      email: s(fd, 'email'),
      provider: 'google',
      subject: s(fd, 'subject'),
      identityEmail: s(fd, 'identityEmail') || undefined,
    });
    revalidatePath('/users');
    return { ok: true, message: 'Identity linked' };
  });
}

/** Remove a linked federated identity from a user (RQ-0011). */
export async function unlinkIdentity(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.unlinkIdentity({ email: s(fd, 'email'), provider: 'google', subject: s(fd, 'subject') });
    revalidatePath('/users');
    return { ok: true, message: 'Identity unlinked' };
  });
}

/** Mint a registration invite (RQ-0013). The code comes back once and is shown via the dialog. */
export async function createInvite(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    // ADR-0020: an invite targets a specific application (applicationId, required) and grants roles from
    // that application's catalogue.
    const res = await api.createInvite({
      applicationId: s(fd, 'applicationId'),
      email: s(fd, 'email') || undefined,
      roles: multi(fd, 'roles'),
      maxUses: Math.max(1, Number(s(fd, 'maxUses') || '1') || 1),
      expiresInHours: Number(s(fd, 'expiresInHours') || '168') || 168,
      note: s(fd, 'note') || undefined
    });
    revalidatePath('/invites');
    return {
      ok: true,
      message: 'Invite created',
      secret: res.code,
      secretHint: `Shown once — send it to the invitee out-of-band (email, chat). Expires ${new Date(res.expiresAt).toLocaleString()}.`
    };
  });
}

export async function revokeInvite(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.revokeInvite(s(fd, 'inviteId'));
    revalidatePath('/invites');
    return { ok: true, message: 'Invite revoked' };
  });
}

export async function rotateKey(_prev?: ActionResult, _fd?: FormData): Promise<ActionResult> {
  return run(async () => {
    const res = await api.rotateKey();
    return { ok: true, message: `Rotated — new kid ${res.kid}` };
  });
}

// --- Per-application entitlements + app-scoped roles (ADR-0020) ---

/** Read helpers, callable from client components to hydrate the drawers (they may throw ApiError). */
export async function fetchApplicationRoles(applicationId: string): Promise<AppRole[]> {
  return api.getApplicationRoles(applicationId);
}
export async function fetchApplicationMembers(applicationId: string): Promise<Member[]> {
  return api.listApplicationMembers(applicationId);
}
export async function fetchApplicationCredentials(applicationId: string): Promise<Client[]> {
  return api.listApplicationCredentials(applicationId);
}
export async function fetchUserAssignments(email: string): Promise<Assignment[]> {
  return api.listUserAssignments(email);
}

/** Replace an application's role catalogue. `roles` arrives as a JSON-encoded AppRole[]. */
export async function setApplicationRoles(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    let roles: AppRole[] = [];
    try { roles = JSON.parse(s(fd, 'roles') || '[]') as AppRole[]; } catch { roles = []; }
    await api.setApplicationRoles(s(fd, 'applicationId'), roles);
    revalidatePath('/applications');
    return { ok: true, message: 'Role catalogue saved' };
  });
}

/** Grant a user access to an application (entitlement + app-scoped roles). */
export async function assignUser(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.assignUser({ email: s(fd, 'email'), applicationId: s(fd, 'applicationId'), roles: multi(fd, 'roles') });
    revalidatePath('/applications');
    revalidatePath('/users');
    return { ok: true, message: 'User assigned' };
  });
}

/**
 * Change an existing assignment — its app-scoped roles and/or its active/suspended status. `roles` is
 * only sent when the form opts in via `_setRoles=1`, so a status-only toggle can't accidentally clear the
 * user's roles (an absent role field and "no boxes checked" are otherwise indistinguishable).
 */
export async function updateAssignment(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const status = s(fd, 'status');
    const includeRoles = s(fd, '_setRoles') === '1';
    await api.updateAssignment({
      email: s(fd, 'email'),
      applicationId: s(fd, 'applicationId'),
      ...(includeRoles ? { roles: multi(fd, 'roles') } : {}),
      ...(status === 'active' || status === 'suspended' ? { status } : {})
    });
    revalidatePath('/applications');
    revalidatePath('/users');
    return { ok: true, message: 'Assignment updated' };
  });
}

/** Revoke a user's access to an application. */
export async function revokeAssignment(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await api.revokeAssignment({ email: s(fd, 'email'), applicationId: s(fd, 'applicationId') });
    revalidatePath('/applications');
    revalidatePath('/users');
    return { ok: true, message: 'Access revoked' };
  });
}
