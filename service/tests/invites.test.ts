import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The admin service pulls in key-store (RSA keygen) transitively; stub it like admin-api.test.ts does.
vi.mock('../src/utils/key-store.js', () => ({
  listPublicKeys: vi.fn(async () => []),
  rotateSigningKey: vi.fn(async () => ({ kid: 'rotated-kid', privateKeyPem: '', publicKeyPem: '' }))
}));

import { createAdminService } from '../src/services/admin.js';
import { createUserService } from '../src/services/users.js';
import { generateInviteCode, inviteCodeDigest, deriveInviteStatus } from '../src/services/invites.js';
import { sha256Hex } from '../src/utils/hash.js';
import { CONFIG } from '../src/config.js';

// --- A compact in-memory mongoose-ish collection covering what the invite paths use -----------

const cmp = (doc: any, key: string, cond: any): boolean => {
  if (cond !== null && typeof cond === 'object') {
    if ('$gt' in cond) return doc[key] != null && doc[key] > cond.$gt;
    if ('$gte' in cond) return doc[key] != null && doc[key] >= cond.$gte;
  }
  if (cond === null) return doc[key] == null; // Mongo: `field: null` matches absent OR null
  return doc[key] === cond;
};
const match = (doc: any, filter: Record<string, any>): boolean =>
  Object.entries(filter ?? {}).every(([k, v]) => cmp(doc, k, v));

const applyUpdate = (doc: any, update: any) => {
  Object.assign(doc, update.$set ?? {});
  for (const [k, delta] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (delta as number);
};

function fakeCollection(items: any[]) {
  const chain = <T>(v: T) => ({
    exec: async () => v,
    lean: function () { return this; },
    sort: function () { return this; },
    select: function () { return this; }
  });
  return {
    _items: items,
    find: (filter: any = {}) => chain(items.filter((d) => match(d, filter))),
    findById: (id: string) => chain(items.find((d) => d._id === id) ?? null),
    findOne: (filter: any) => chain(items.find((d) => match(d, filter)) ?? null),
    countDocuments: (filter: any = {}) => ({ exec: async () => items.filter((d) => match(d, filter)).length }),
    create: async (doc: any) => {
      if (doc._id != null && items.some((d) => d._id === doc._id)) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      items.push({ ...doc });
      return doc;
    },
    findByIdAndUpdate: (id: string, update: any) => {
      const doc = items.find((d) => d._id === id);
      if (doc) applyUpdate(doc, update);
      return chain(doc ?? null);
    },
    // The atomic redemption gate: filter + mutate in one step, exactly what the service leans on.
    findOneAndUpdate: (filter: any, update: any) => {
      const doc = items.find((d) => match(d, filter));
      if (doc) applyUpdate(doc, update);
      return chain(doc ?? null);
    },
    updateOne: (filter: any, update: any) => ({
      exec: async () => {
        const doc = items.find((d) => match(d, filter));
        if (!doc) return { matchedCount: 0 };
        applyUpdate(doc, update);
        return { matchedCount: 1 };
      }
    })
  };
}

const NOW = new Date('2026-07-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function makeState() {
  return {
    User: fakeCollection([]),
    Invite: fakeCollection([]),
    AuditLog: fakeCollection([]),
    OAuthClient: fakeCollection([]),
    OAuthToken: fakeCollection([]),
    KeyStore: fakeCollection([])
  };
}

const deps = (state: ReturnType<typeof makeState>) => ({
  getMasterConnection: async () => ({}) as any,
  makeModels: () => state as any,
  now: () => NOW
});

describe('invite code primitives', () => {
  it('mints XXXX-XXXX-XXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateInviteCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('digests case- and dash-insensitively (humans retype these)', () => {
    expect(inviteCodeDigest('v7qk 3mhp xa2d')).toBe(inviteCodeDigest('V7QK-3MHP-XA2D'));
    expect(inviteCodeDigest('V7QK-3MHP-XA2D')).toBe(sha256Hex('V7QK3MHPXA2D'));
  });

  it('derives status with revoked > redeemed > expired precedence', () => {
    const base = { usesRemaining: 1, expiresAt: new Date(NOW.getTime() + HOUR), revokedAt: null };
    expect(deriveInviteStatus(base, NOW)).toBe('pending');
    expect(deriveInviteStatus({ ...base, revokedAt: NOW, usesRemaining: 0 }, NOW)).toBe('revoked');
    expect(deriveInviteStatus({ ...base, usesRemaining: 0, expiresAt: new Date(0) }, NOW)).toBe('redeemed');
    expect(deriveInviteStatus({ ...base, expiresAt: NOW }, NOW)).toBe('expired');
  });
});

describe('admin service — invites (RQ-0013)', () => {
  let state: ReturnType<typeof makeState>;
  let admin: ReturnType<typeof createAdminService>;
  let savedRoles: string[];
  beforeEach(() => {
    // Role vocabulary is deployment config now (AUTH_ALLOWED_ROLES), not a tenant field.
    savedRoles = CONFIG.auth.allowedRoles;
    (CONFIG.auth as any).allowedRoles = ['tenant_admin', 'member'];
    state = makeState();
    admin = createAdminService(deps(state));
  });
  afterEach(() => { (CONFIG.auth as any).allowedRoles = savedRoles; });

  it('creates an invite, returns the code once, and stores only its digest', async () => {
    const { inviteId, code, expiresAt } = await admin.createInvite({});
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 7 * 24 * HOUR)); // 7-day default
    const stored = state.Invite._items.find((i) => i._id === inviteId);
    expect(stored.codeDigest).toBe(inviteCodeDigest(code));
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));
    expect(stored).toMatchObject({ maxUses: 1, usesRemaining: 1, roles: [] });
  });

  it('normalizes a bound email and validates roles against AUTH_ALLOWED_ROLES', async () => {
    const { inviteId } = await admin.createInvite({ email: ' New@Example.COM ', roles: ['member'] });
    expect(state.Invite._items.find((i) => i._id === inviteId)).toMatchObject({ email: 'new@example.com', roles: ['member'] });
    await expect(admin.createInvite({ roles: ['superuser'] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    await expect(admin.createInvite({ email: 'not-an-email' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_email' });
    await expect(admin.createInvite({ maxUses: 0 }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('lists invites with derived status and usedCount, never the code digest', async () => {
    const { inviteId } = await admin.createInvite({ maxUses: 2, note: 'March cohort' });
    await admin.createInvite({ expiresInHours: -1 }).catch(() => {}); // rejected, not stored
    state.Invite._items.find((i) => i._id === inviteId).usesRemaining = 1; // one redemption happened

    const listed = await admin.listInvites();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ _id: inviteId, status: 'pending', usedCount: 1, maxUses: 2, note: 'March cohort' });
    expect(listed[0]).not.toHaveProperty('codeDigest');
  });

  it('revokes an invite (listing it as revoked) and 404s on an unknown id', async () => {
    const { inviteId } = await admin.createInvite({});
    expect(await admin.revokeInvite(inviteId)).toEqual({ inviteId, revoked: true });
    expect((await admin.listInvites())[0].status).toBe('revoked');
    await expect(admin.revokeInvite('nope')).rejects.toMatchObject({ status: 404, code: 'invite_not_found' });
  });
});

describe('registration policy gate + redemption (RQ-0013)', () => {
  let state: ReturnType<typeof makeState>;
  let admin: ReturnType<typeof createAdminService>;
  let users: ReturnType<typeof createUserService>;

  // Registration policy is deployment config now (AUTH_REGISTRATION_MODE), not a tenant field.
  let savedMode: 'open' | 'invite' | 'closed';
  beforeEach(() => { savedMode = CONFIG.auth.registrationMode; });
  afterEach(() => { (CONFIG.auth as any).registrationMode = savedMode; });

  const setup = (registration: 'open' | 'invite' | 'closed' = 'open') => {
    (CONFIG.auth as any).registrationMode = registration;
    state = makeState();
    admin = createAdminService(deps(state));
    users = createUserService(deps(state));
  };
  const register = (email: string, inviteCode?: string) =>
    users.registerUser({ email, password: 'long-enough-pw', inviteCode });

  it('an open deployment (or one with no policy) registers exactly as before, code or not', async () => {
    setup();
    await expect(register('a@x.test')).resolves.toMatchObject({ email: 'a@x.test' });
    await expect(register('b@x.test', 'IGNORED-CODE')).resolves.toMatchObject({ email: 'b@x.test' });
    expect(state.Invite._items).toHaveLength(0); // open never consults invites
  });

  it('a closed deployment refuses self-registration outright', async () => {
    setup('closed');
    await expect(register('a@x.test')).rejects.toMatchObject({ status: 403, code: 'registration_closed' });
  });

  it('an invite deployment requires a code, and rejects garbage/expired/revoked codes generically', async () => {
    setup('invite');
    await expect(register('a@x.test')).rejects.toMatchObject({ status: 403, code: 'invite_required' });
    await expect(register('a@x.test', 'NOPE-NOPE-NOPE')).rejects.toMatchObject({ status: 403, code: 'invalid_invite' });

    const expired = await admin.createInvite({ expiresInHours: 1 });
    state.Invite._items.find((i) => i._id === expired.inviteId).expiresAt = new Date(NOW.getTime() - HOUR);
    await expect(register('a@x.test', expired.code)).rejects.toMatchObject({ code: 'invalid_invite' });

    const revoked = await admin.createInvite({});
    await admin.revokeInvite(revoked.inviteId);
    await expect(register('a@x.test', revoked.code)).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('redeems a valid code: user created, roles stamped, a use consumed, redemption audited', async () => {
    setup('invite');
    const { inviteId, code } = await admin.createInvite({ roles: ['member'] });

    const user = await register('new@x.test', code.toLowerCase().replace(/-/g, '')); // humane entry forms work
    expect(state.User._items[0]).toMatchObject({ email: 'new@x.test', roles: ['member'], emailVerified: false });
    expect(state.Invite._items[0].usesRemaining).toBe(0);
    expect(state.AuditLog._items[0]).toMatchObject({
      action: 'invite.redeem', targetType: 'invite', targetId: inviteId,
      meta: { userId: user.id, email: 'new@x.test' }
    });

    // Single-use: the same code cannot admit a second person.
    await expect(register('second@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('a multi-use cohort code admits exactly maxUses people', async () => {
    setup('invite');
    const { code } = await admin.createInvite({ maxUses: 2 });
    await register('one@x.test', code);
    await register('two@x.test', code);
    await expect(register('three@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(state.User._items).toHaveLength(2);
  });

  it('an email-bound invite only admits (and then vouches) its address; a mismatch refunds the use', async () => {
    setup('invite');
    const { code } = await admin.createInvite({ email: 'invited@x.test' });

    await expect(register('intruder@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(state.Invite._items[0].usesRemaining).toBe(1); // refunded — the mismatch burned nothing

    await register('Invited@X.test', code);
    expect(state.User._items[0]).toMatchObject({ email: 'invited@x.test', emailVerified: true }); // ADR-0013: operator vouched
  });

  it('email_taken after a valid code refunds the use (a rejected registration never burns one)', async () => {
    setup('invite');
    state.User._items.push({ _id: 'u0', email: 'taken@x.test', createdAt: new Date(0) });
    const { code } = await admin.createInvite({});
    await expect(register('taken@x.test', code)).rejects.toMatchObject({ status: 409, code: 'email_taken' });
    expect(state.Invite._items[0].usesRemaining).toBe(1);
    await expect(register('fresh@x.test', code)).resolves.toBeTruthy(); // still redeemable
  });

  it('input validation fires before any invite is consulted (no use burned on a weak password)', async () => {
    setup('invite');
    const { code } = await admin.createInvite({});
    await expect(users.registerUser({ email: 'a@x.test', password: 'short', inviteCode: code }))
      .rejects.toMatchObject({ code: 'weak_password' });
    expect(state.Invite._items[0].usesRemaining).toBe(1);
  });
});
