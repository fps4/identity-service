import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveOperatorEmail, declaredRoles, seatChanges } from '../scripts/seed.js';

/** The seed's record helpers (ADR-0022): who its acts are attributed to, and what a re-run emits. */
describe('seed: the operator', () => {
  it('is --as, else SEED_AS, else the first user in the file, normalised', () => {
    expect(resolveOperatorEmail(['--as=Ops@Example.test'], {}, 'first@example.test')).toBe('ops@example.test');
    expect(resolveOperatorEmail([], { SEED_AS: 'env@example.test' }, 'first@example.test')).toBe('env@example.test');
    expect(resolveOperatorEmail([], {}, 'First@example.test')).toBe('first@example.test');
    expect(resolveOperatorEmail([], {}, undefined)).toBeUndefined();
  });
});

describe('seed: seats', () => {
  it('reads a credential\'s declared roles as a list or a string', () => {
    expect(declaredRoles({ roles: ['author', 'reviewer'] })).toEqual(['author', 'reviewer']);
    expect(declaredRoles({ roles: 'author reviewer' })).toEqual(['author', 'reviewer']);
    expect(declaredRoles({ role: 'product_runtime' })).toEqual([]);
    expect(declaredRoles(undefined)).toEqual([]);
  });

  it('emits one change per role that changed hands, and nothing for a re-run that changes nothing', () => {
    expect(seatChanges('prn-h-x', 'app1', ['member'], ['member'], 'O0')).toEqual([]);
    expect(seatChanges('prn-h-x', 'app1', ['member'], ['member', 'reviewer'], 'O0').map((a) => a.body)).toEqual([
      { seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O0' }
    ]);
    expect(seatChanges('prn-a-x', 'app1', ['author'], [], 'O1').map((a) => a.body)).toEqual([
      { seat: 'author', application: 'app1', change: 'revoked', oversight_level: 'O1' }
    ]);
  });
});

import { runSeed } from '../scripts/seed.js';
import { parseSeedConfig } from '../src/services/seed-config.js';
import { testStore, type TestStore } from './helpers/store.js';

describe('seed: a run on the record', () => {
  let fresh: TestStore;
  let ghost: TestStore;
  beforeAll(async () => {
    fresh = await testStore();
    ghost = await testStore();
  });
  afterAll(async () => {
    await fresh.drop();
    await ghost.drop();
  });

  const config = parseSeedConfig({
    applications: [{
      id: 'app1', name: 'app1', audience: 'app1-ws',
      roles: [{ key: 'member' }, { key: 'operator' }],
      credentials: [
        { id: 'app1-web', name: 'web', grantTypes: ['password'], isConfidential: false },
        { id: 'app1-agent', name: 'agent', grantTypes: ['client_credentials'], isConfidential: true, claims: { principal_kind: 'agent', roles: ['member'] } }
      ]
    }],
    users: [
      { email: 'ops@example.test', password: 'ops-password-123', status: 'active', assignments: [{ application: 'app1', roles: ['operator'] }] },
      { email: 'ann@example.test', password: 'ann-password-123', status: 'active', assignments: [{ application: 'app1', roles: ['member'] }] }
    ]
  }, {});
  const record = { workspaceId: 'ws-identity-test', consequenceClass: 'c1' };

  it('registers the operator first, by themselves, then everything else as the operator; a re-run emits only what changed', async () => {
    const { store } = fresh;
    const run = () => runSeed({ config, store, operatorEmail: 'ops@example.test', record });

    const first = await run();
    expect(first).toMatchObject({ appsUpserted: 1, clientsUpserted: 2, usersCreated: 2, usersSkipped: 0, assignmentsUpserted: 2 });
    const events = await store.outbox.list();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const ops = first.operatorPrincipalId;
    expect(ops).toMatch(/^prn-h-/);
    // The operator's own registration is the first event of the realm, attributed to themselves.
    expect(events[0]).toMatchObject({ type: 'PrincipalRegistered', subject_id: ops, acting: ops, accountable: ops, seat: 'self', body: { kind: 'human', source: 'seed', realm: 'identity-test' } });
    // Everything after is the operator's act.
    for (const e of events.slice(1)) expect(e).toMatchObject({ acting: ops, accountable: ops, seat: 'operator', oversight_level: 'O0', correlation_id: events[0].correlation_id });
    const bodies = events.map((e) => ({ type: e.type, ...e.body }));
    expect(bodies).toContainEqual({ type: 'PrincipalRegistered', kind: 'agent', source: 'seed', realm: 'identity-test' });
    expect(bodies).toContainEqual({ type: 'SeatOccupancyChanged', seat: 'member', application: 'app1', change: 'granted', oversight_level: 'O1' });
    expect(bodies).toContainEqual({ type: 'SeatOccupancyChanged', seat: 'operator', application: 'app1', change: 'granted', oversight_level: 'O0' });
    expect(bodies.filter((b) => b.type === 'PrincipalRegistered')).toHaveLength(3); // ops, ann, the agent — not the login credential
    expect((await store.clients.get('app1-web'))!.principalId).toBeUndefined();
    expect((await store.clients.get('app1-agent'))!.principalId).toMatch(/^prn-a-/);
    expect(first.eventsEmitted).toBe(events.length);
    // The application's structure, the credential's, and the assignments are what the file said.
    expect(await store.applications.get('app1')).toMatchObject({ name: 'app1', audience: 'app1-ws', roles: [{ key: 'member' }, { key: 'operator' }], resources: [] });
    expect(await store.clients.get('app1-agent')).toMatchObject({ applicationId: 'app1', grantTypes: ['client_credentials'], isConfidential: true });
    const ann = (await store.users.getByEmail('ann@example.test'))!;
    expect(await store.assignments.get(ann._id, 'app1')).toMatchObject({ roles: ['member'], status: 'active', createdBy: 'seed' });

    const second = await run();
    expect(second).toMatchObject({ usersCreated: 0, usersSkipped: 2, eventsEmitted: 0 });
    expect(await store.outbox.list()).toHaveLength(events.length);
    // A re-run reconciles structure and never a secret (ADR-0021): the agent's hash is the first run's.
    const agentBefore = (await store.clients.get('app1-agent'))!;
    expect(agentBefore.secretHash).toBeTruthy();

    // A changed file: one more role for ann is one more event; a removed agent role is one revocation.
    const changed = parseSeedConfig({
      applications: [{ ...config.applications[0], credentials: [config.applications[0].credentials![0], { ...config.applications[0].credentials![1], claims: { principal_kind: 'agent', roles: [] } }] }],
      users: [config.users[0], { ...config.users[1], assignments: [{ application: 'app1', roles: ['member', 'operator'] }] }]
    }, {});
    const third = await runSeed({ config: changed, store, operatorEmail: 'ops@example.test', record });
    expect(third.eventsEmitted).toBe(2);
    expect((await store.clients.get('app1-agent'))!.secretHash).toBe(agentBefore.secretHash);
    const tail = (await store.outbox.list()).slice(-2).map((e) => e.body);
    expect(tail).toContainEqual({ seat: 'member', application: 'app1', change: 'revoked', oversight_level: 'O1' });
    expect(tail).toContainEqual({ seat: 'operator', application: 'app1', change: 'granted', oversight_level: 'O0' });
  });

  it('refuses to run for an operator that is neither in the pool nor in the file', async () => {
    await expect(runSeed({ config, store: ghost.store, operatorEmail: 'ghost@example.test', record })).rejects.toThrow(/neither in the pool nor in the seed file/);
  });
});
