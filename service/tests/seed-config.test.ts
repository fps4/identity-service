import { describe, it, expect } from 'vitest';
import { parseSeedConfig, SeedConfigError } from '../src/services/seed-config.js';

// Nested shape (ADR-0020): one deployment = one realm, a set of APPLICATIONS — each owning its role
// catalogue, default audience, and credentials (OAuth clients) — plus local users and their per-application
// assignments. No tenant layer above the application.
const base = {
  applications: [{
    id: 'demo', name: 'Demo', audience: 'demo-workspace',
    credentials: [{ id: 'demo-web', grantTypes: ['password'] }]
  }],
  users: [{ email: 'Demo@FPS4.nl', password: '${SEED_DEMO_PASSWORD}' }]
};

describe('parseSeedConfig (RQ-0004)', () => {
  it('parses a valid config, interpolates env, and normalizes the email', () => {
    const cfg = parseSeedConfig(base, { SEED_DEMO_PASSWORD: 'correct-horse-battery' });
    expect(cfg.applications[0].id).toBe('demo');
    expect(cfg.applications[0].audience).toBe('demo-workspace');
    expect(cfg.applications[0].credentials?.[0].id).toBe('demo-web');
    expect(cfg.users[0].email).toBe('demo@fps4.nl');           // lowercased
    expect(cfg.users[0].password).toBe('correct-horse-battery'); // ${ENV} resolved
  });

  it('throws when a referenced env var is unset', () => {
    expect(() => parseSeedConfig(base, {})).toThrowError(/SEED_DEMO_PASSWORD/);
  });

  it('requires an audience (on the credential or the application) for the password grant', () => {
    // Neither the application nor the credential names an audience → rejected.
    const bad = { applications: [{ id: 'a', name: 'A', credentials: [{ id: 'c', grantTypes: ['password'] }] }] };
    expect(() => parseSeedConfig(bad, {})).toThrowError(/audience/);
    // A credential-level audience override satisfies it even without an application default.
    const ok = { applications: [{ id: 'a', name: 'A', credentials: [{ id: 'c', grantTypes: ['password'], audience: 'a-ws' }] }] };
    expect(() => parseSeedConfig(ok, {})).not.toThrow();
  });

  // US-0086 — a product_runtime client-credentials principal: subject + additive claims
  it('parses a client-credentials runtime principal (subject + claims)', () => {
    const cfg = parseSeedConfig({
      applications: [{
        id: 'gw', name: 'Gateway', audience: 'maestro-workspace',
        credentials: [{ id: 'gw-ds1', grantTypes: ['client_credentials'],
          isConfidential: true, secret: '${GW_SECRET}',
          subject: 'runtime@gw.fps4.nl',
          claims: { role: 'product_runtime', email: 'runtime@gw.fps4.nl' } }]
      }]
    }, { GW_SECRET: 'shh' });
    const c = cfg.applications[0].credentials![0];
    expect(c.subject).toBe('runtime@gw.fps4.nl');
    expect(c.claims).toEqual({ role: 'product_runtime', email: 'runtime@gw.fps4.nl' });
    expect(c.secret).toBe('shh');                                   // ${ENV} interpolated
  });

  it('rejects credential claims that are not an object', () => {
    const bad = { applications: [{ id: 'a', name: 'A', credentials: [{ id: 'c', grantTypes: ['client_credentials'], claims: 'not-an-object' }] }] };
    expect(() => parseSeedConfig(bad, {})).toThrowError(/claims must be an object/);
  });

  it('requires an id and non-empty grantTypes on every credential', () => {
    expect(() => parseSeedConfig({ applications: [{ id: 'a', name: 'A', credentials: [{ grantTypes: ['client_credentials'] }] }] })).toThrowError(/id is required/);
    expect(() => parseSeedConfig({ applications: [{ id: 'a', name: 'A', credentials: [{ id: 'c' }] }] })).toThrowError(/grantTypes/);
    expect(() => parseSeedConfig({ applications: [{ id: 'a', name: 'A', credentials: [{ id: 'c', grantTypes: [] }] }] })).toThrowError(/grantTypes/);
  });

  it('requires an id and a name on every application', () => {
    expect(() => parseSeedConfig({ applications: [{ name: 'A' }] })).toThrowError(/id is required/);
    expect(() => parseSeedConfig({ applications: [{ id: 'a' }] })).toThrowError(/needs a name/);
  });

  it('rejects a non-object config and a mistyped applications/users list', () => {
    expect(() => parseSeedConfig(null)).toThrow(SeedConfigError);
    expect(() => parseSeedConfig('nope')).toThrow(SeedConfigError);
    expect(() => parseSeedConfig({ applications: 'nope' })).toThrowError(/applications` must be an array/);
    expect(() => parseSeedConfig({ users: 'nope' })).toThrowError(/users` must be an array/);
  });

  it('rejects an invalid user email and a missing password', () => {
    expect(() => parseSeedConfig({ users: [{ email: 'not-an-email', password: 'correct-horse-battery' }] }, {}))
      .toThrowError(/valid email/);
    expect(() => parseSeedConfig({ users: [{ email: 'a@x.test' }] }, {}))
      .toThrowError(/needs a password/);
  });

  // ADR-0020 — a user carries per-application `assignments` ({ application, roles? }), and an application
  // owns a role `catalogue` (`roles`) that assignments are validated against.
  it('parses per-application assignments + application role catalogues, defaulting roles/assignments to []', () => {
    const cfg = parseSeedConfig({
      applications: [{
        id: 'demo', name: 'Demo', audience: 'demo-workspace',
        roles: [{ key: 'platform_admin' }, { key: 'member', name: 'Member', description: 'a member' }],
        credentials: [{ id: 'demo-web', grantTypes: ['password'] }]
      }],
      users: [{
        email: 'a@x.test', password: 'correct-horse-battery',
        assignments: [{ application: 'demo', roles: ['platform_admin', 'member'] }]
      }]
    }, {});
    expect(cfg.applications[0].roles).toEqual([
      { key: 'platform_admin', name: undefined, description: undefined },
      { key: 'member', name: 'Member', description: 'a member' }
    ]);
    expect(cfg.users[0].assignments).toEqual([{ application: 'demo', roles: ['platform_admin', 'member'] }]);

    // A user with no assignments block defaults to an empty array (no app access until assigned).
    const noAssign = parseSeedConfig({
      users: [{ email: 'b@x.test', password: 'correct-horse-battery' }]
    }, {});
    expect(noAssign.users[0].assignments).toEqual([]);

    // An assignment with no roles defaults its roles to an empty array.
    const noRoles = parseSeedConfig({
      applications: [{ id: 'demo', name: 'Demo', audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'c@x.test', password: 'correct-horse-battery', assignments: [{ application: 'demo' }] }]
    }, {});
    expect(noRoles.users[0].assignments).toEqual([{ application: 'demo', roles: [] }]);
  });

  it('rejects an assignment to an unknown application, a stray role, and a catalogue entry missing its key', () => {
    // An assignment must reference a declared application.
    expect(() => parseSeedConfig({
      applications: [{ id: 'demo', name: 'Demo', audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'a@x.test', password: 'correct-horse-battery', assignments: [{ application: 'ghost' }] }]
    }, {})).toThrowError(/unknown application "ghost"/);

    // An assigned role must be in that application's catalogue.
    expect(() => parseSeedConfig({
      applications: [{ id: 'demo', name: 'Demo', audience: 'demo-workspace', roles: [{ key: 'member' }] }],
      users: [{ email: 'a@x.test', password: 'correct-horse-battery', assignments: [{ application: 'demo', roles: ['superuser'] }] }]
    }, {})).toThrowError(/"superuser" is not in application demo's roles catalogue/);

    // A catalogue entry needs a non-empty key.
    expect(() => parseSeedConfig({
      applications: [{ id: 'demo', name: 'Demo', audience: 'demo-workspace', roles: [{ name: 'no key' }] }]
    }, {})).toThrowError(/needs a non-empty key/);
  });

  it('accepts an empty config with no applications or users', () => {
    const cfg = parseSeedConfig({});
    expect(cfg.applications).toEqual([]);
    expect(cfg.users).toEqual([]);
  });
});
