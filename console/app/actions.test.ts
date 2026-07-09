import { describe, it, expect, vi, beforeEach } from 'vitest';

// Server Actions are the console's mutation path (each rides the operator token via lib/api). These
// cover the success and the ApiError-failure branch of the shared `run()` wrapper (RQ-0008).

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    createClient: vi.fn(),
    rotateClientSecret: vi.fn(),
    createUser: vi.fn(),
    linkIdentity: vi.fn(),
    unlinkIdentity: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
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

  it('createClient returns the one-time secret on success', async () => {
    apiMock.createClient.mockResolvedValue({ clientId: 'c-1', secret: 's3cr3t' });
    const { createClient } = await import('@/app/actions');

    const res = await createClient(
      { ok: false },
      form({ name: 'svc', grantTypes: 'client_credentials', scopes: 'admin' }),
    );

    expect(res.ok).toBe(true);
    expect(res.secret).toBe('s3cr3t');
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

  it('createInvite returns the one-time code as show-once material (RQ-0013)', async () => {
    apiMock.createInvite.mockResolvedValue({ inviteId: 'i-1', code: 'V7QK-3MHP-XA2D', expiresAt: '2026-07-10T12:00:00.000Z' });
    const { createInvite } = await import('@/app/actions');

    const res = await createInvite({ ok: false }, form({ email: 'new@acme.com', roles: 'member', maxUses: '2', expiresInHours: '168', note: 'cohort' }));

    expect(res.ok).toBe(true);
    expect(res.secret).toBe('V7QK-3MHP-XA2D');
    expect(res.secretHint).toContain('Shown once');
    expect(apiMock.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new@acme.com', roles: ['member'], maxUses: 2, expiresInHours: 168, note: 'cohort' }),
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
});
