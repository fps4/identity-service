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

import { Transaction, type Store } from '../src/db/index.js';
import { testStore, type TestStore } from './helpers/store.js';

const NOW = new Date('2026-07-03T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

// The application an invite entitles its redeemer to (ADR-0020), with a role catalogue the invite's
// roles are validated against.
const APP = {
  _id: 'app-web', name: 'App Web', audience: 'app-workspace',
  roles: [{ key: 'tenant_admin' }, { key: 'member' }], resources: []
};

// A table of the test's own on DynamoDB Local, with the application in it.
async function makeState(): Promise<TestStore> {
  const db = await testStore();
  await db.store.applications.create({ ...APP });
  return db;
}

const deps = (store: Store) => ({ store, now: () => NOW });

/** Every invite in the table, oldest first. */
const invites = (store: Store) => store.invites.list().then((rows) => rows.reverse());

/** Take one use, as a registration's transaction would. */
async function redeemOnce(store: Store, inviteId: string): Promise<void> {
  const tx = new Transaction();
  store.invites.redeem(tx, inviteId, NOW);
  await store.commit(tx);
}

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
  let db: TestStore;
  let state: Store;
  let admin: ReturnType<typeof createAdminService>;
  let savedRoles: string[];
  beforeEach(async () => {
    // Role vocabulary is deployment config now (AUTH_ALLOWED_ROLES), not a tenant field.
    savedRoles = CONFIG.auth.allowedRoles;
    (CONFIG.auth as any).allowedRoles = ['tenant_admin', 'member'];
    db = await makeState();
    state = db.store;
    admin = createAdminService(deps(state));
  });
  afterEach(async () => { (CONFIG.auth as any).allowedRoles = savedRoles; await db.drop(); });

  it('creates an invite, returns the code once, and stores only its digest', async () => {
    const { inviteId, code, expiresAt } = await admin.createInvite({ applicationId: 'app-web' });
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 7 * 24 * HOUR)); // 7-day default
    const stored = (await state.invites.get(inviteId))!;
    expect(stored.codeDigest).toBe(inviteCodeDigest(code));
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ''));
    expect(stored).toMatchObject({ maxUses: 1, usesRemaining: 1, roles: [] });
    // The digest resolves the invite — what a redemption looks up.
    expect(await state.invites.getByDigest(inviteCodeDigest(code))).toMatchObject({ _id: inviteId });
  });

  it('normalizes a bound email, stores the applicationId, and validates roles against the app catalogue (ADR-0020)', async () => {
    const { inviteId } = await admin.createInvite({ applicationId: 'app-web', email: ' New@Example.COM ', roles: ['member'] });
    expect(await state.invites.get(inviteId)).toMatchObject({ applicationId: 'app-web', email: 'new@example.com', roles: ['member'] });
    // A role outside the application's catalogue is rejected loud at creation, not at the invitee's redemption.
    await expect(admin.createInvite({ applicationId: 'app-web', roles: ['superuser'] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_role' });
    await expect(admin.createInvite({ applicationId: 'app-web', email: 'not-an-email' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_email' });
    await expect(admin.createInvite({ applicationId: 'app-web', maxUses: 0 }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    // applicationId is required (ADR-0020), and must reference a known application.
    await expect(admin.createInvite({} as any))
      .rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    await expect(admin.createInvite({ applicationId: 'ghost' }))
      .rejects.toMatchObject({ status: 404, code: 'application_not_found' });
  });

  it('lists invites with derived status and usedCount, never the code digest', async () => {
    const { inviteId } = await admin.createInvite({ applicationId: 'app-web', maxUses: 2, note: 'March cohort' });
    await admin.createInvite({ applicationId: 'app-web', expiresInHours: -1 }).catch(() => {}); // rejected, not stored
    await redeemOnce(state, inviteId); // one redemption happened

    const listed = await admin.listInvites();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ _id: inviteId, status: 'pending', usedCount: 1, maxUses: 2, note: 'March cohort' });
    expect(listed[0]).not.toHaveProperty('codeDigest');
  });

  it('revokes an invite (listing it as revoked) and 404s on an unknown id', async () => {
    const { inviteId } = await admin.createInvite({ applicationId: 'app-web' });
    expect(await admin.revokeInvite(inviteId)).toEqual({ inviteId, revoked: true });
    expect((await admin.listInvites())[0].status).toBe('revoked');
    await expect(admin.revokeInvite('nope')).rejects.toMatchObject({ status: 404, code: 'invite_not_found' });
  });
});

describe('registration policy gate + redemption (RQ-0013)', () => {
  let db: TestStore;
  let state: Store;
  let admin: ReturnType<typeof createAdminService>;
  let users: ReturnType<typeof createUserService>;

  // Registration policy is deployment config now (AUTH_REGISTRATION_MODE), not a tenant field.
  let savedMode: 'open' | 'invite' | 'closed';
  beforeEach(() => { savedMode = CONFIG.auth.registrationMode; });
  afterEach(async () => { (CONFIG.auth as any).registrationMode = savedMode; await db?.drop(); });

  const setup = async (registration: 'open' | 'invite' | 'closed' = 'open') => {
    (CONFIG.auth as any).registrationMode = registration;
    db = await makeState();
    state = db.store;
    admin = createAdminService(deps(state));
    users = createUserService(deps(state));
  };
  const register = (email: string, inviteCode?: string) =>
    users.registerUser({ email, password: 'long-enough-pw', inviteCode });

  it('an open deployment (or one with no policy) registers exactly as before, code or not', async () => {
    await setup();
    await expect(register('a@x.test')).resolves.toMatchObject({ email: 'a@x.test' });
    await expect(register('b@x.test', 'IGNORED-CODE')).resolves.toMatchObject({ email: 'b@x.test' });
    expect(await invites(state)).toHaveLength(0); // open never consults invites
  });

  it('a closed deployment refuses self-registration outright', async () => {
    await setup('closed');
    await expect(register('a@x.test')).rejects.toMatchObject({ status: 403, code: 'registration_closed' });
  });

  it('an invite deployment requires a code, and rejects garbage/expired/revoked codes generically', async () => {
    await setup('invite');
    await expect(register('a@x.test')).rejects.toMatchObject({ status: 403, code: 'invite_required' });
    await expect(register('a@x.test', 'NOPE-NOPE-NOPE')).rejects.toMatchObject({ status: 403, code: 'invalid_invite' });

    // An invite good for an hour, presented two hours later.
    const expired = await admin.createInvite({ applicationId: 'app-web', expiresInHours: 1 });
    const later = createUserService({ store: state, now: () => new Date(NOW.getTime() + 2 * HOUR) });
    await expect(later.registerUser({ email: 'a@x.test', password: 'long-enough-pw', inviteCode: expired.code })).rejects.toMatchObject({ code: 'invalid_invite' });

    const revoked = await admin.createInvite({ applicationId: 'app-web' });
    await admin.revokeInvite(revoked.inviteId);
    await expect(register('a@x.test', revoked.code)).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('redeems a valid code: user created, roles stamped, a use consumed, redemption audited', async () => {
    await setup('invite');
    const { inviteId, code } = await admin.createInvite({ applicationId: 'app-web', roles: ['member'] });

    const user = await register('new@x.test', code.toLowerCase().replace(/-/g, '')); // humane entry forms work
    // The user itself no longer carries roles (ADR-0019) — they live on the assignment created on redemption.
    const stored = (await state.users.get(user.id))!;
    expect(stored).toMatchObject({ email: 'new@x.test', emailVerified: false });
    expect(stored).not.toHaveProperty('roles');
    expect(await state.assignments.get(user.id, 'app-web')).toMatchObject({
      userId: user.id, applicationId: 'app-web', roles: ['member'], status: 'active', createdBy: `invite:${inviteId}`
    });
    expect((await state.invites.get(inviteId))!.usesRemaining).toBe(0);
    expect((await state.audit.latest(10))[0]).toMatchObject({
      action: 'invite.redeem', targetType: 'invite', targetId: inviteId,
      meta: { userId: user.id, email: 'new@x.test', applicationId: 'app-web' }
    });

    // Single-use: the same code cannot admit a second person.
    await expect(register('second@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('a multi-use cohort code admits exactly maxUses people', async () => {
    await setup('invite');
    const { code } = await admin.createInvite({ applicationId: 'app-web', maxUses: 2 });
    await register('one@x.test', code);
    await register('two@x.test', code);
    await expect(register('three@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect(await state.users.count()).toBe(2);
  });

  it('an email-bound invite only admits (and then vouches) its address; a mismatch refunds the use', async () => {
    await setup('invite');
    const { inviteId, code } = await admin.createInvite({ applicationId: 'app-web', email: 'invited@x.test' });

    await expect(register('intruder@x.test', code)).rejects.toMatchObject({ code: 'invalid_invite' });
    expect((await state.invites.get(inviteId))!.usesRemaining).toBe(1); // the mismatch burned nothing

    await register('Invited@X.test', code);
    expect(await state.users.getByEmail('invited@x.test')).toMatchObject({ email: 'invited@x.test', emailVerified: true }); // ADR-0013: operator vouched
  });

  it('email_taken after a valid code burns no use (a rejected registration is one transaction that never happened)', async () => {
    await setup('invite');
    const tx = new Transaction();
    state.users.put(tx, { _id: 'u0', email: 'taken@x.test', identities: [], emailVerified: false, status: 'active', failedAttempts: 0, createdAt: new Date(0), updatedAt: new Date(0) });
    await state.commit(tx);
    const { inviteId, code } = await admin.createInvite({ applicationId: 'app-web' });
    await expect(register('taken@x.test', code)).rejects.toMatchObject({ status: 409, code: 'email_taken' });
    expect((await state.invites.get(inviteId))!.usesRemaining).toBe(1);
    await expect(register('fresh@x.test', code)).resolves.toBeTruthy(); // still redeemable
  });

  it('two registrations racing the last use: one is admitted, the other refused, the use taken once', async () => {
    await setup('invite');
    const { inviteId, code } = await admin.createInvite({ applicationId: 'app-web' });
    const outcomes = await Promise.allSettled([register('first@x.test', code), register('second@x.test', code)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect((await state.invites.get(inviteId))!.usesRemaining).toBe(0);
    expect(await state.users.count()).toBe(1);
  });

  it('input validation fires before any invite is consulted (no use burned on a weak password)', async () => {
    await setup('invite');
    const { inviteId, code } = await admin.createInvite({ applicationId: 'app-web' });
    await expect(users.registerUser({ email: 'a@x.test', password: 'short', inviteCode: code }))
      .rejects.toMatchObject({ code: 'weak_password' });
    expect((await state.invites.get(inviteId))!.usesRemaining).toBe(1);
  });
});
