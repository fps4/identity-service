import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server Actions are the console's mutation path (each rides the operator token via lib/api). These
// cover the success and the ApiError-failure branch of the shared `run()` wrapper (RQ-0008).

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    createApplication: vi.fn(),
    deleteApplication: vi.fn(),
    createClient: vi.fn(),
    rotateClientSecret: vi.fn(),
    createUser: vi.fn(),
    linkIdentity: vi.fn(),
    unlinkIdentity: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    setApplicationRoles: vi.fn(),
    assignUser: vi.fn(),
    updateAssignment: vi.fn(),
    revokeAssignment: vi.fn(),
  },
}));

class FakeApiError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: FakeApiError }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe('console server actions', () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((m) => m.mockReset());
  });

  it('createClient registers a credential under an application and returns the one-time secret (ADR-0020)', async () => {
    apiMock.createClient.mockResolvedValue({ clientId: 'c-1', secret: 's3cr3t' });
    const { createClient } = await import('@/app/actions');

    const res = await createClient(
      { ok: false },
      form({ applicationId: 'app-1', name: 'svc', grantTypes: 'client_credentials', scopes: 'admin' }),
    );

    expect(res.ok).toBe(true);
    expect(res.secret).toBe('s3cr3t');
    expect(apiMock.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', name: 'svc', grantTypes: ['client_credentials'], scopes: ['admin'] }),
    );
  });

  it('createApplication creates a product with a seeded role catalogue (ADR-0020)', async () => {
    apiMock.createApplication.mockResolvedValue({ applicationId: 'app-1' });
    const { createApplication } = await import('@/app/actions');

    const res = await createApplication({ ok: false }, form({ name: 'acme-web', audience: 'acme', roles: 'admin, member' }));

    expect(res.ok).toBe(true);
    expect(apiMock.createApplication).toHaveBeenCalledWith({ name: 'acme-web', audience: 'acme', roles: [{ key: 'admin' }, { key: 'member' }] });
  });

  it('deleteApplication forwards the id and reports success (ADR-0020)', async () => {
    apiMock.deleteApplication.mockResolvedValue({ applicationId: 'app-1', deleted: true });
    const { deleteApplication } = await import('@/app/actions');

    const res = await deleteApplication({ ok: false }, form({ applicationId: 'app-1' }));

    expect(res.ok).toBe(true);
    expect(apiMock.deleteApplication).toHaveBeenCalledWith('app-1');
  });

  it('linkIdentity forwards a google identity link and reports success (RQ-0011)', async () => {
    apiMock.linkIdentity.mockResolvedValue({ email: 'op@acme.test', provider: 'google', subject: 'g-1', linked: true });
    const { linkIdentity } = await import('@/app/actions');

    const res = await linkIdentity({ ok: false }, form({ email: 'op@acme.test', subject: 'g-1' }));

    expect(res.ok).toBe(true);
    expect(apiMock.linkIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'op@acme.test', provider: 'google', subject: 'g-1' }),
    );
  });

  it('unlinkIdentity forwards a google identity unlink and reports success (RQ-0011)', async () => {
    apiMock.unlinkIdentity.mockResolvedValue({ email: 'op@acme.test', provider: 'google', subject: 'g-1', unlinked: true });
    const { unlinkIdentity } = await import('@/app/actions');

    const res = await unlinkIdentity({ ok: false }, form({ email: 'op@acme.test', subject: 'g-1' }));

    expect(res.ok).toBe(true);
    expect(apiMock.unlinkIdentity).toHaveBeenCalledWith(
      { email: 'op@acme.test', provider: 'google', subject: 'g-1' },
    );
  });

  it('surfaces the ApiError message when linking a subject already owned', async () => {
    apiMock.linkIdentity.mockRejectedValue(new FakeApiError('Identity is already linked to another user', 409, 'identity_linked'));
    const { linkIdentity } = await import('@/app/actions');

    const res = await linkIdentity({ ok: false }, form({ email: 'b@acme.test', subject: 'shared' }));

    expect(res.ok).toBe(false);
    expect(res.message).toBe('Identity is already linked to another user');
  });

  it('createInvite targets an application and returns the one-time code (RQ-0013, ADR-0020)', async () => {
    apiMock.createInvite.mockResolvedValue({ inviteId: 'i-1', code: 'V7QK-3MHP-XA2D', expiresAt: '2026-07-10T12:00:00.000Z' });
    const { createInvite } = await import('@/app/actions');

    const res = await createInvite({ ok: false }, form({ applicationId: 'app-1', email: 'new@acme.com', roles: 'member', maxUses: '2', expiresInHours: '168', note: 'cohort' }));

    expect(res.ok).toBe(true);
    expect(res.secret).toBe('V7QK-3MHP-XA2D');
    expect(res.secretHint).toContain('Shown once');
    expect(apiMock.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', email: 'new@acme.com', roles: ['member'], maxUses: 2, expiresInHours: 168, note: 'cohort' }),
    );
  });

  it('revokeInvite forwards the id and reports success (RQ-0013)', async () => {
    apiMock.revokeInvite.mockResolvedValue({ inviteId: 'i-1', revoked: true });
    const { revokeInvite } = await import('@/app/actions');

    const res = await revokeInvite({ ok: false }, form({ inviteId: 'i-1' }));

    expect(res.ok).toBe(true);
    expect(apiMock.revokeInvite).toHaveBeenCalledWith('i-1');
  });

  it('returns ok:false with the ApiError message on failure', async () => {
    apiMock.createUser.mockRejectedValue(new FakeApiError('email already exists', 409, 'duplicate'));
    const { createUser } = await import('@/app/actions');

    const res = await createUser({ ok: false }, form({ email: 'a@b.com', password: 'pw' }));

    expect(res.ok).toBe(false);
    expect(res.message).toBe('email already exists');
  });

  // --- Per-application entitlements + app-scoped roles (ADR-0020) ---

  it('createUser no longer forwards roles (ADR-0020)', async () => {
    apiMock.createUser.mockResolvedValue({ id: 'u-1', email: 'a@b.com' });
    const { createUser } = await import('@/app/actions');

    await createUser({ ok: false }, form({ email: 'a@b.com', password: 'pw', roles: 'admin' }));

    expect(apiMock.createUser).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw' });
    expect(apiMock.createUser).not.toHaveBeenCalledWith(expect.objectContaining({ roles: expect.anything() }));
  });

  it('assignUser grants an entitlement with app-scoped roles', async () => {
    apiMock.assignUser.mockResolvedValue({ email: 'a@b.com', applicationId: 'app-1', roles: ['admin', 'member'], status: 'active' });
    const { assignUser } = await import('@/app/actions');
    const fd = new FormData();
    fd.set('email', 'a@b.com');
    fd.set('applicationId', 'app-1');
    fd.append('roles', 'admin');
    fd.append('roles', 'member');

    const res = await assignUser({ ok: false }, fd);

    expect(res.ok).toBe(true);
    expect(apiMock.assignUser).toHaveBeenCalledWith({ email: 'a@b.com', applicationId: 'app-1', roles: ['admin', 'member'] });
  });

  it('updateAssignment status-only toggle does NOT send roles (guards against wiping them)', async () => {
    apiMock.updateAssignment.mockResolvedValue({ email: 'a@b.com', applicationId: 'app-1', roles: ['member'], status: 'suspended' });
    const { updateAssignment } = await import('@/app/actions');

    await updateAssignment({ ok: false }, form({ email: 'a@b.com', applicationId: 'app-1', status: 'suspended' }));

    expect(apiMock.updateAssignment).toHaveBeenCalledWith({ email: 'a@b.com', applicationId: 'app-1', status: 'suspended' });
    expect(apiMock.updateAssignment).not.toHaveBeenCalledWith(expect.objectContaining({ roles: expect.anything() }));
  });

  it('updateAssignment with the _setRoles marker sends the (possibly empty) role set', async () => {
    apiMock.updateAssignment.mockResolvedValue({ email: 'a@b.com', applicationId: 'app-1', roles: [], status: 'active' });
    const { updateAssignment } = await import('@/app/actions');

    await updateAssignment({ ok: false }, form({ email: 'a@b.com', applicationId: 'app-1', _setRoles: '1' }));

    expect(apiMock.updateAssignment).toHaveBeenCalledWith({ email: 'a@b.com', applicationId: 'app-1', roles: [] });
  });

  it('setApplicationRoles parses the JSON-encoded catalogue and forwards it', async () => {
    apiMock.setApplicationRoles.mockResolvedValue(['admin']);
    const { setApplicationRoles } = await import('@/app/actions');
    const roles = JSON.stringify([{ key: 'admin', name: 'Admin' }, { key: 'member' }]);

    const res = await setApplicationRoles({ ok: false }, form({ applicationId: 'app-1', roles }));

    expect(res.ok).toBe(true);
    expect(apiMock.setApplicationRoles).toHaveBeenCalledWith('app-1', [{ key: 'admin', name: 'Admin' }, { key: 'member' }]);
  });

  it('revokeAssignment forwards email + applicationId and reports success', async () => {
    apiMock.revokeAssignment.mockResolvedValue({ email: 'a@b.com', applicationId: 'app-1', revoked: true });
    const { revokeAssignment } = await import('@/app/actions');

    const res = await revokeAssignment({ ok: false }, form({ email: 'a@b.com', applicationId: 'app-1' }));

    expect(res.ok).toBe(true);
    expect(apiMock.revokeAssignment).toHaveBeenCalledWith({ email: 'a@b.com', applicationId: 'app-1' });
  });
});
