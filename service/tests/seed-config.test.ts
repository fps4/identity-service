import { describe, it, expect } from 'vitest';
import { parseSeedConfig, SeedConfigError } from '../src/services/seed-config.js';

// Flat shape (ADR-0018): one deployment = one realm, so a single `clients` + `users` set, no tenant layer.
const base = {
  clients: [{ id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace' }],
  users: [{ email: 'Demo@FPS4.nl', password: '${SEED_DEMO_PASSWORD}' }]
};

describe('parseSeedConfig (RQ-0004)', () => {
  it('parses a valid config, interpolates env, and normalizes the email', () => {
    const cfg = parseSeedConfig(base, { SEED_DEMO_PASSWORD: 'correct-horse-battery' });
    expect(cfg.clients[0].id).toBe('demo-web');
    expect(cfg.clients[0].audience).toBe('demo-workspace');
    expect(cfg.users[0].email).toBe('demo@fps4.nl');           // lowercased
    expect(cfg.users[0].password).toBe('correct-horse-battery'); // ${ENV} resolved
  });

  it('throws when a referenced env var is unset', () => {
    expect(() => parseSeedConfig(base, {})).toThrowError(/SEED_DEMO_PASSWORD/);
  });

  it('requires an audience for the password grant', () => {
    const bad = { clients: [{ id: 'c', grantTypes: ['password'] }] };
    expect(() => parseSeedConfig(bad, {})).toThrowError(/audience/);
  });

  // US-0086 — a product_runtime client-credentials principal: subject + additive claims
  it('parses a client-credentials runtime principal (subject + claims)', () => {
    const cfg = parseSeedConfig({
      clients: [{ id: 'gw-ds1', grantTypes: ['client_credentials'], audience: 'maestro-workspace',
        isConfidential: true, secret: '${GW_SECRET}',
        subject: 'runtime@gw.fps4.nl',
        claims: { role: 'product_runtime', email: 'runtime@gw.fps4.nl' } }]
    }, { GW_SECRET: 'shh' });
    const c = cfg.clients[0];
    expect(c.subject).toBe('runtime@gw.fps4.nl');
    expect(c.claims).toEqual({ role: 'product_runtime', email: 'runtime@gw.fps4.nl' });
    expect(c.secret).toBe('shh');                                   // ${ENV} interpolated
  });

  it('rejects client claims that are not an object', () => {
    const bad = { clients: [{ id: 'c', grantTypes: ['client_credentials'], claims: 'not-an-object' }] };
    expect(() => parseSeedConfig(bad, {})).toThrowError(/claims must be an object/);
  });

  it('requires an id and non-empty grantTypes on every client', () => {
    expect(() => parseSeedConfig({ clients: [{ grantTypes: ['client_credentials'] }] })).toThrowError(/id is required/);
    expect(() => parseSeedConfig({ clients: [{ id: 'c' }] })).toThrowError(/grantTypes/);
    expect(() => parseSeedConfig({ clients: [{ id: 'c', grantTypes: [] }] })).toThrowError(/grantTypes/);
  });

  it('rejects a non-object config and a mistyped clients/users list', () => {
    expect(() => parseSeedConfig(null)).toThrow(SeedConfigError);
    expect(() => parseSeedConfig('nope')).toThrow(SeedConfigError);
    expect(() => parseSeedConfig({ clients: 'nope' })).toThrowError(/clients` must be an array/);
    expect(() => parseSeedConfig({ users: 'nope' })).toThrowError(/users` must be an array/);
  });

  it('rejects an invalid user email and a missing password', () => {
    expect(() => parseSeedConfig({ users: [{ email: 'not-an-email', password: 'correct-horse-battery' }] }, {}))
      .toThrowError(/valid email/);
    expect(() => parseSeedConfig({ users: [{ email: 'a@x.test' }] }, {}))
      .toThrowError(/needs a password/);
  });

  // ADR-0019 — a user carries per-application `assignments` ({ client, roles? }) instead of flat roles,
  // and a client carries a role `catalogue` that assignments are validated against.
  it('parses per-application assignments + client role catalogues, defaulting roles/assignments to []', () => {
    const cfg = parseSeedConfig({
      clients: [{
        id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace',
        roles: [{ key: 'platform_admin' }, { key: 'member', name: 'Member', description: 'a member' }]
      }],
      users: [{
        email: 'a@x.test', password: 'correct-horse-battery',
        assignments: [{ client: 'demo-web', roles: ['platform_admin', 'member'] }]
      }]
    }, {});
    expect(cfg.clients[0].roles).toEqual([
      { key: 'platform_admin', name: undefined, description: undefined },
      { key: 'member', name: 'Member', description: 'a member' }
    ]);
    expect(cfg.users[0].assignments).toEqual([{ client: 'demo-web', roles: ['platform_admin', 'member'] }]);

    // A user with no assignments block defaults to an empty array (no app access until assigned).
    const noAssign = parseSeedConfig({
      users: [{ email: 'b@x.test', password: 'correct-horse-battery' }]
    }, {});
    expect(noAssign.users[0].assignments).toEqual([]);

    // An assignment with no roles defaults its roles to an empty array.
    const noRoles = parseSeedConfig({
      clients: [{ id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'c@x.test', password: 'correct-horse-battery', assignments: [{ client: 'demo-web' }] }]
    }, {});
    expect(noRoles.users[0].assignments).toEqual([{ client: 'demo-web', roles: [] }]);
  });

  it('rejects an assignment to an unknown client, a stray role, and a catalogue entry missing its key', () => {
    // An assignment must reference a declared client.
    expect(() => parseSeedConfig({
      clients: [{ id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'a@x.test', password: 'correct-horse-battery', assignments: [{ client: 'ghost' }] }]
    }, {})).toThrowError(/unknown client "ghost"/);

    // An assigned role must be in that client's catalogue.
    expect(() => parseSeedConfig({
      clients: [{ id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'a@x.test', password: 'correct-horse-battery', assignments: [{ client: 'demo-web', roles: ['superuser'] }] }]
    }, {})).toThrowError(/"superuser" is not in client demo-web's roles catalogue/);

    // A catalogue entry needs a non-empty key.
    expect(() => parseSeedConfig({
      clients: [{ id: 'demo-web', grantTypes: ['password'], audience: 'demo-workspace', roles: [{ name: 'no key' }] }]
    }, {})).toThrowError(/needs a non-empty key/);
  });

  it('accepts an empty/flat config with no clients or users', () => {
    const cfg = parseSeedConfig({});
    expect(cfg.clients).toEqual([]);
    expect(cfg.users).toEqual([]);
  });
});
