import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateKeyPairSync } from 'crypto';
import { decodeJwt } from 'jose';
import { FsArchive, InProcessDelivery, parseEventLine, sealBefore, verifyRange, type SpineEvent } from '@fps4/maestro-spine';

const { privateKey: testPrivateKeyPem, publicKey: testPublicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
vi.mock('../src/utils/key-store.js', () => ({
  getActiveKeyPair: vi.fn(async () => ({ kid: 'test-kid', privateKeyPem: testPrivateKeyPem, publicKeyPem: testPublicKeyPem })),
  ensureActiveSigningKey: vi.fn(async () => ({ kid: 'test-kid', privateKeyPem: testPrivateKeyPem, publicKeyPem: testPublicKeyPem })),
  listPublicKeys: vi.fn(async () => []),
  rotateSigningKey: vi.fn()
}));

import { createAdminService, AdminServiceError } from '../src/services/admin.js';
import { createUserService } from '../src/services/users.js';
import { createOAuthServer } from '../src/oauth/server.js';
import { hashSecret } from '../src/utils/hash.js';
import { actContextFor, createRelay, ActRefused, type RecordConfig, type ActContext } from '../src/record/index.js';
import { Transaction, type Store } from '../src/db/index.js';
import { testStore, type TestStore } from './helpers/store.js';

/**
 * The record end to end (ADR-0022): what the registry emits is the spine's envelope, attributed at the
 * act; the relay carries it unchanged into an archive; the spine's verifier passes on what was sealed.
 * maestro's M1 gate from this side of the seam, over a table of this file's own on DynamoDB Local.
 */

const record: RecordConfig = { workspaceId: 'ws-identity-test', consequenceClass: 'c1' };

let db: TestStore;
let store: Store;
let archiveDir: string;
let operator: ActContext;

const deps = (cfg: RecordConfig = record) => ({ store, record: cfg });

async function outbox(): Promise<Array<SpineEvent & { delivered: boolean }>> {
  return (await store.outbox.list()) as unknown as Array<SpineEvent & { delivered: boolean }>;
}
const ofType = async (type: string) => (await outbox()).filter((e) => e.type === type);
const userByEmail = async (email: string) => (await store.users.getByEmail(email))!;

beforeAll(async () => {
  db = await testStore(record.workspaceId);
  store = db.store;
  archiveDir = await mkdtemp(join(tmpdir(), 'identity-archive-'));
  const now = new Date();
  await store.applications.create({ _id: 'app1', name: 'app1', audience: 'app1-ws', roles: [{ key: 'member' }, { key: 'reviewer' }, { key: 'operator' }], resources: [] }, now);
  // The bootstrap operator predates the registry: no principalId yet. Their first act backfills one.
  const tx = new Transaction();
  store.users.put(tx, { _id: 'u-operator', email: 'operator@example.test', status: 'active', identities: [], emailVerified: false, passwordHash: hashSecret('operator-password-1'), failedAttempts: 0, createdAt: now, updatedAt: now });
  store.assignments.put(tx, { userId: 'u-operator', applicationId: 'app1', roles: ['operator'], status: 'active', createdAt: now, updatedAt: now });
  await store.commit(tx);
  operator = await actContextFor(store, { kind: 'operator', subject: 'u-operator', scopes: ['admin'] });
});

afterAll(async () => {
  await rm(archiveDir, { recursive: true, force: true });
  await db.drop();
});

describe('the registry emits its lifecycle', () => {
  it('backfills a principal id for a user that predates the registry, without inventing a registration', async () => {
    expect(operator.actor).toMatchObject({ kind: 'human', seat: 'operator' });
    expect(operator.actor.principal).toMatch(/^prn-h-/);
    expect((await store.users.get('u-operator'))!.principalId).toBe(operator.actor.principal);
    expect(await store.principals.get(operator.actor.principal)).toMatchObject({ kind: 'human', status: 'active', subjectType: 'user', subjectId: 'u-operator' });
    expect(await store.principals.getBySubject('user', 'u-operator')).toMatchObject({ _id: operator.actor.principal });
    expect(await outbox()).toEqual([]);
  });

  it('registering a user records PrincipalRegistered with prn-h ids in acting, accountable and subject', async () => {
    const admin = createAdminService(deps());
    const created = await admin.createUser({ email: 'alice@example.test', password: 'alice-password-1' }, operator);
    expect(created.principalId).toMatch(/^prn-h-/);
    const [event] = await ofType('PrincipalRegistered');
    expect(event).toMatchObject({
      workspace_id: 'ws-identity-test',
      seq: 1,
      subject_type: 'principal',
      subject_id: created.principalId,
      subject_seq: 1,
      type_version: 1,
      accountable: operator.actor.principal,
      acting: operator.actor.principal,
      seat: 'operator',
      oversight_level: 'O0',
      consequence_class: 'c1',
      causation_id: null,
      correlation_id: operator.correlation_id,
      body: { kind: 'human', source: 'local', realm: 'identity-test' },
      delivered: false
    });
    expect(event.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(event)).not.toContain('alice@');
    const user = await userByEmail('alice@example.test');
    expect(user.principalId).toBe(created.principalId);
    expect(await store.principals.get(created.principalId!)).toMatchObject({ kind: 'human', status: 'active', subjectType: 'user', subjectId: user._id });
  });

  it('a role granted is a seat occupied; changed and revoked roles follow', async () => {
    const admin = createAdminService(deps());
    const alice = await userByEmail('alice@example.test');
    await admin.assignUser({ email: 'alice@example.test', applicationId: 'app1', roles: ['member'] }, operator);
    let seats = await ofType('SeatOccupancyChanged');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ subject_id: alice.principalId, body: { seat: 'member', application: 'app1', change: 'granted', oversight_level: 'O0' } });

    // The same assignment again: nothing changed hands, nothing recorded.
    await admin.assignUser({ email: 'alice@example.test', applicationId: 'app1', roles: ['member'] }, operator);
    expect(await ofType('SeatOccupancyChanged')).toHaveLength(1);

    await admin.updateAssignment('alice@example.test', 'app1', { roles: ['reviewer'] }, operator);
    seats = await ofType('SeatOccupancyChanged');
    expect(seats.slice(1).map((e) => e.body)).toEqual([
      { seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O0' },
      { seat: 'member', application: 'app1', change: 'revoked', oversight_level: 'O0' }
    ]);
    // Events of one act chain by causation to the first of them and share the request's correlation.
    expect(seats[2].causation_id).toBe(seats[1].event_id);
    expect(seats[2].correlation_id).toBe(seats[1].correlation_id);

    await admin.updateAssignment('alice@example.test', 'app1', { status: 'suspended' }, operator);
    expect((await ofType('SeatOccupancyChanged')).at(-1)!.body).toEqual({ seat: 'reviewer', application: 'app1', change: 'revoked', oversight_level: 'O0' });
    await admin.updateAssignment('alice@example.test', 'app1', { status: 'active' }, operator);
    expect((await ofType('SeatOccupancyChanged')).at(-1)!.body).toEqual({ seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O0' });

    await admin.revokeAssignment('alice@example.test', 'app1', operator);
    expect((await ofType('SeatOccupancyChanged')).at(-1)!.body).toEqual({ seat: 'reviewer', application: 'app1', change: 'revoked', oversight_level: 'O0' });
  });

  it('suspending and reinstating a user are recorded once each, not per call', async () => {
    const admin = createAdminService(deps());
    const alice = await userByEmail('alice@example.test');
    await admin.setUserStatus('alice@example.test', 'disabled', operator);
    await admin.setUserStatus('alice@example.test', 'disabled', operator);
    const suspended = await ofType('PrincipalSuspended');
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({ subject_id: alice.principalId, body: { reason: 'disabled' } });
    expect((await store.principals.get(alice.principalId!))!.status).toBe('suspended');

    await admin.setUserStatus('alice@example.test', 'active', operator);
    const reinstated = await ofType('PrincipalReinstated');
    expect(reinstated).toHaveLength(1);
    expect(reinstated[0].body).toEqual({ reason: 'enabled' });
    expect((await store.principals.get(alice.principalId!))!.status).toBe('active');

    // Unlocking an active user clears counters and records nothing.
    await admin.unlockUser('alice@example.test', operator);
    expect(await ofType('PrincipalReinstated')).toHaveLength(1);
  });

  it('a machine credential is an agent or a workload principal, with its declared roles as seats at O1', async () => {
    const admin = createAdminService(deps());
    const { clientId, principalId } = await admin.createClient({
      applicationId: 'app1', name: 'runner', grantTypes: ['client_credentials'], scopes: ['admin'],
      claims: { principal_kind: 'agent', roles: ['reviewer'] }
    }, operator);
    expect(principalId).toMatch(/^prn-a-/);
    const registered = (await ofType('PrincipalRegistered')).find((e) => e.subject_id === principalId)!;
    expect(registered.body).toEqual({ kind: 'agent', source: 'client_credentials', realm: 'identity-test' });
    const seat = (await ofType('SeatOccupancyChanged')).find((e) => e.subject_id === principalId)!;
    expect(seat.body).toEqual({ seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O1' });
    expect(seat.causation_id).toBe(registered.event_id);

    const workload = await admin.createClient({ applicationId: 'app1', id: 'relay', name: 'relay', grantTypes: ['client_credentials'] }, operator);
    expect(workload.principalId).toMatch(/^prn-w-/);
    const login = await admin.createClient({ applicationId: 'app1', id: 'web', name: 'web', grantTypes: ['password'], isConfidential: false }, operator);
    expect(login.principalId).toBeUndefined();

    await admin.deleteClient(clientId, operator);
    const last = (await outbox()).slice(-2);
    expect(last[0].body).toEqual({ seat: 'reviewer', application: 'app1', change: 'revoked', oversight_level: 'O1' });
    expect(last[1]).toMatchObject({ type: 'PrincipalSuspended', subject_id: principalId, body: { reason: 'deleted' } });
    // The registry row outlives the credential, retired: the archive can still say an agent acted.
    expect(await store.principals.get(principalId!)).toMatchObject({ kind: 'agent', status: 'retired' });
    expect(await store.clients.get(clientId)).toBeNull();
  });

  it('a machine actor answers to the configured human; without one it cannot act and nothing is written', async () => {
    const relayClient = (await store.clients.get('relay'))!;
    const machine = await actContextFor(store, { kind: 'machine', clientId: relayClient._id, scopes: ['admin'] });
    expect(machine.actor).toMatchObject({ principal: relayClient.principalId, kind: 'workload', seat: 'operator' });

    const unanswerable = createAdminService(deps({ ...record, accountable: undefined }));
    const before = (await outbox()).length;
    await expect(unanswerable.createUser({ email: 'bob@example.test', password: 'bob-password-12' }, machine)).rejects.toThrow(ActRefused);
    expect((await outbox()).length).toBe(before);
    expect(await store.users.getByEmail('bob@example.test')).toBeNull();

    const answerable = createAdminService(deps({ ...record, accountable: operator.actor.principal }));
    const bob = await answerable.createUser({ email: 'bob@example.test', password: 'bob-password-12' }, machine);
    const event = (await outbox()).at(-1)!;
    expect(event).toMatchObject({
      subject_id: bob.principalId,
      acting: relayClient.principalId,
      accountable: operator.actor.principal,
      seat: 'operator',
      oversight_level: 'O4'
    });
  });

  it('an act with no acting principal is refused when the record is wired', async () => {
    const admin = createAdminService(deps());
    await expect(admin.createUser({ email: 'carol@example.test', password: 'carol-password-1' })).rejects.toThrow(/no acting principal/);
    expect(await store.users.getByEmail('carol@example.test')).toBeNull();
  });

  it('a role key that is not a token is refused at the catalogue, so a grant can always be recorded', async () => {
    const admin = createAdminService(deps());
    await expect(admin.setApplicationRoles('app1', [{ key: 'senior reviewer' }])).rejects.toThrow(AdminServiceError);
    await expect(admin.createApplication({ id: 'my app', name: 'x' })).rejects.toThrow(/identifier/);
  });

  it('self-registration is the person\'s own act in the self seat; an invite\'s roles are seats granted in the same breath', async () => {
    const now = new Date();
    await store.invites.create({ _id: 'inv-1', applicationId: 'app1', codeDigest: (await import('../src/services/invites.js')).inviteCodeDigest('CODE-1'), roles: ['member'], maxUses: 1, usesRemaining: 1, expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null, createdAt: now, updatedAt: now });
    const { CONFIG } = await import('../src/config.js');
    const previous = CONFIG.auth.registrationMode;
    (CONFIG.auth as any).registrationMode = 'invite';
    try {
      const users = createUserService(deps());
      const dave = await users.registerUser({ email: 'dave@example.test', password: 'dave-password-12', inviteCode: 'CODE-1' });
      expect(dave.principalId).toMatch(/^prn-h-/);
      const events = (await outbox()).filter((e) => e.subject_id === dave.principalId);
      expect(events.map((e) => e.type)).toEqual(['PrincipalRegistered', 'SeatOccupancyChanged']);
      expect(events[0]).toMatchObject({ acting: dave.principalId, accountable: dave.principalId, seat: 'self', oversight_level: 'O0', body: { source: 'local' } });
      expect(events[1]).toMatchObject({ causation_id: events[0].event_id, body: { seat: 'member', application: 'app1', change: 'granted', oversight_level: 'O0' } });
      expect(await store.assignments.get(dave.id, 'app1')).toMatchObject({ roles: ['member'], status: 'active' });
      expect((await store.invites.get('inv-1'))!.usesRemaining).toBe(0);
    } finally {
      (CONFIG.auth as any).registrationMode = previous;
    }
  });

  it('deleting a user revokes every seat and suspends the principal for deletion; the registry row is retained, retired', async () => {
    const admin = createAdminService(deps());
    const dave = await userByEmail('dave@example.test');
    await admin.deleteUser('dave@example.test', operator);
    const events = (await outbox()).filter((e) => e.subject_id === dave.principalId).slice(-2);
    expect(events[0].body).toEqual({ seat: 'member', application: 'app1', change: 'revoked', oversight_level: 'O0' });
    expect(events[1]).toMatchObject({ type: 'PrincipalSuspended', body: { reason: 'deleted' } });
    // The deletion's events chain to the first of them across the transactions it took.
    expect(events[1].causation_id).toBe(events[0].event_id);
    expect(await store.principals.get(dave.principalId!)).toMatchObject({ status: 'retired', kind: 'human' });
    expect(await store.users.get(dave._id)).toBeNull();
    expect(await store.users.getByEmail('dave@example.test')).toBeNull();
    expect(await store.assignments.listByUser(dave._id)).toEqual([]);
  });

  it('seq is contiguous per workspace and subject_seq per principal', async () => {
    const events = await outbox();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const bySubject = new Map<string, number[]>();
    for (const e of events) bySubject.set(e.subject_id, [...(bySubject.get(e.subject_id) ?? []), e.subject_seq]);
    for (const seqs of bySubject.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('two acts racing on the workspace serialise on the counter: both land, in order, without a gap', async () => {
    const admin = createAdminService(deps());
    const before = (await outbox()).length;
    await Promise.all([
      admin.createUser({ email: 'race-1@example.test', password: 'race-password-1' }, operator),
      admin.createUser({ email: 'race-2@example.test', password: 'race-password-2' }, operator),
      admin.createUser({ email: 'race-3@example.test', password: 'race-password-3' }, operator)
    ]);
    const events = await outbox();
    expect(events.length).toBe(before + 3);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(new Set(events.slice(-3).map((e) => e.subject_id)).size).toBe(3);
  });
});

describe('the relay', () => {
  it('carries the envelope into the archive unchanged, and the verifier passes with the service off', async () => {
    const relay = createRelay(async () => store, { archive: new FsArchive(archiveDir), delivery: new InProcessDelivery() });
    const report = await relay.drain();
    expect(report.refused).toEqual([]);
    const emitted = await outbox();
    expect(report.acked).toBe(emitted.length);
    expect(emitted.every((e) => e.delivered === true)).toBe(true);
    expect((relay.delivery as InProcessDelivery).published.map((e) => e.seq)).toEqual(emitted.map((e) => e.seq));

    const ws = 'ws-identity-test';
    const days = await relay.archive.listDays(ws);
    expect(days).toHaveLength(1);
    const parts = await relay.archive.listParts(ws, days[0]);
    const lines = (await Promise.all(parts.map((p) => relay.archive.readPart(ws, days[0], p)))).flat();
    const archived = lines.map(parseEventLine);
    expect(archived.map((e) => e.seq)).toEqual(emitted.map((e) => e.seq));
    const { delivered, delivered_at, attempts, ...envelope } = emitted[0] as any;
    expect(archived[0]).toEqual(envelope);
    for (const line of lines) expect(line).not.toMatch(/@example\.test|u-operator/);

    // Seal as the sealer would, then verify as an auditor would: the pure verifier over the store.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const sealed = await sealBefore(relay.archive, tomorrow);
    expect(sealed.map((m) => m.workspace_id)).toContain(ws);
    const verdict = await verifyRange(relay.archive, ws);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.last_seq).toBe(emitted.length);
  });

  it('a second drain changes nothing', async () => {
    const relay = createRelay(async () => store, { archive: new FsArchive(archiveDir), delivery: new InProcessDelivery() });
    expect(await relay.drain()).toEqual({ archived: 0, published: 0, acked: 0, refused: [] });
    expect(await store.outbox.pending(10)).toEqual([]);
  });
});

describe('tokens carry the principal', () => {
  const server = () => createOAuthServer({ ...deps(), now: () => new Date() });

  it('a client-credentials token carries prn and principal_kind, backfilling a credential that predates the registry', async () => {
    const now = new Date();
    await store.clients.create({ _id: 'legacy-runtime', applicationId: 'app1', name: 'legacy', secretHash: hashSecret('s3cret-s3cret-s3cret'), grantTypes: ['client_credentials'], redirectUris: [], scopes: ['telemetry:write'], isConfidential: true, claims: { role: 'product_runtime' }, createdAt: now, updatedAt: now });
    const before = (await outbox()).length;
    const token = await server().issueClientCredentialsToken({ clientId: 'legacy-runtime', clientSecret: 's3cret-s3cret-s3cret' });
    const claims = decodeJwt(token.accessToken);
    expect(claims.prn).toMatch(/^prn-w-/);
    expect(claims.principal_kind).toBe('workload');
    expect(claims.role).toBe('product_runtime');
    expect((await store.clients.get('legacy-runtime'))!.principalId).toBe(claims.prn);
    expect((await outbox()).length).toBe(before); // a backfill mints; it does not invent a registration

    // A credential that declares its kind keeps that claim as consumers read it today.
    const runner = (await store.clients.get('relay'))!;
    await store.clients.create({ _id: 'declared-agent', applicationId: 'app1', name: 'agent', secretHash: hashSecret('agent-secret-agent'), grantTypes: ['client_credentials'], redirectUris: [], scopes: [], isConfidential: true, claims: { principal_kind: 'agent', roles: ['reviewer'] }, principalId: 'prn-a-declaredagent', createdAt: now, updatedAt: now });
    const tx = new Transaction();
    store.principals.register(tx, { _id: 'prn-a-declaredagent', kind: 'agent', status: 'active', subjectType: 'client', subjectId: 'declared-agent', createdAt: now, updatedAt: now });
    await store.commit(tx);
    const agent = decodeJwt((await server().issueClientCredentialsToken({ clientId: 'declared-agent', clientSecret: 'agent-secret-agent' })).accessToken);
    expect(agent).toMatchObject({ prn: 'prn-a-declaredagent', principal_kind: 'agent', roles: ['reviewer'] });
    expect(runner.principalId).toMatch(/^prn-w-/);
  });

  it('a first Google login registers the person on the record, by themselves; the token still carries the provider sub', async () => {
    const { createHash } = await import('crypto');
    const verifier = 'a-code-verifier-that-is-long-enough-for-pkce-0123456789';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const now = new Date();
    await store.clients.create({ _id: 'google-web', applicationId: 'app1', name: 'google-web', secretHash: '', grantTypes: ['authorization_code'], redirectUris: ['https://app.example.test/cb'], scopes: [], isConfidential: false, createdAt: now, updatedAt: now });
    const authorization = {
      _id: 'authz-1', clientId: 'google-web', consumerRedirectUri: 'https://app.example.test/cb', codeChallenge: challenge, codeChallengeMethod: 'S256' as const,
      scope: ['openid'], idp: 'google' as const, googleState: 'gs-1', nonce: 'n', status: 'pending' as const,
      expiresAt: new Date(Date.now() + 600_000), createdAt: now
    };
    await store.authorizations.create(authorization);
    expect(await store.authorizations.authenticate(authorization, { code: 'code-1', email: 'erin@example.test', sub: 'google-sub-erin', emailVerified: true })).toBe(true);
    // The person must already be assigned (an operator or an invite did that) or the gate refuses a token;
    // JIT provisioning happens first, so the assignment is keyed on the user id it will get. Seed the
    // assignment lookup by provisioning through the gate once it exists: assign after registration below.
    const before = (await outbox()).length;
    await expect(server().issueAuthorizationCodeToken({ code: 'code-1', codeVerifier: verifier, clientId: 'google-web', redirectUri: 'https://app.example.test/cb' })).rejects.toThrow(/Access denied/);
    const erin = await userByEmail('erin@example.test');
    expect(erin.principalId).toMatch(/^prn-h-/);
    expect(await store.users.getByIdentity('google', 'google-sub-erin')).toMatchObject({ _id: erin._id });
    const registered = (await outbox()).slice(before);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      type: 'PrincipalRegistered', subject_id: erin.principalId, acting: erin.principalId, accountable: erin.principalId, seat: 'self',
      body: { kind: 'human', source: 'google', realm: 'identity-test' }
    });
    expect(JSON.stringify(registered[0])).not.toContain('google-sub-erin');

    // Assigned, a second login issues the token: `sub` is still Google's subject; `prn` is ours.
    const tx = new Transaction();
    store.assignments.put(tx, { userId: erin._id, applicationId: 'app1', roles: ['member'], status: 'active', createdAt: now, updatedAt: now });
    await store.commit(tx);
    const second = { ...authorization, _id: 'authz-2', googleState: 'gs-2' };
    await store.authorizations.create(second);
    await store.authorizations.authenticate(second, { code: 'code-2', email: 'erin@example.test', sub: 'google-sub-erin', emailVerified: true });
    const token = await server().issueAuthorizationCodeToken({ code: 'code-2', codeVerifier: verifier, clientId: 'google-web', redirectUri: 'https://app.example.test/cb' });
    expect(decodeJwt(token.accessToken)).toMatchObject({ sub: 'google-sub-erin', prn: erin.principalId, principal_kind: 'human', roles: ['member'] });
    expect((await outbox()).length).toBe(before + 1);
  });

  it('a user token carries prn and principal_kind: human, beside the unchanged sub, email and roles', async () => {
    const alice = await userByEmail('alice@example.test');
    await store.users.update(alice._id, { passwordHash: hashSecret('alice-password-1') });
    const now = new Date();
    const tx = new Transaction();
    store.assignments.put(tx, { userId: alice._id, applicationId: 'app1', roles: ['member'], status: 'active', createdAt: now, updatedAt: now });
    await store.commit(tx);
    const token = await server().issuePasswordToken({ username: 'alice@example.test', password: 'alice-password-1', clientId: 'web' });
    const claims = decodeJwt(token.accessToken);
    expect(claims).toMatchObject({ sub: alice._id, email: 'alice@example.test', roles: ['member'], prn: alice.principalId, principal_kind: 'human', aud: 'app1-ws' });
  });
});
