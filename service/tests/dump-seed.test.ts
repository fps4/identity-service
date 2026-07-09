import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildSeed, toSeedYaml, passwordEnvVar, type DumpApplication, type DumpCredential, type DumpUser, type DumpAssignment } from '../scripts/dump-seed.js';
import { parseSeedConfig } from '../src/services/seed-config.js';

// Live applications (ADR-0020: the product-level unit) with their credentials, users, and assignments:
// a machine (client_credentials) credential under one app and a human (password) credential under another,
// plus a local user assigned to the human app.
const applications: DumpApplication[] = [
  { _id: 'telemetry', name: 'Telemetry' },
  { _id: 'demo', name: 'Demo', audience: 'demo-workspace', roles: [{ key: 'member' }] }
];
const credentials: DumpCredential[] = [
  { _id: 'telemetry-ingest', applicationId: 'telemetry', name: 'Ingest', grantTypes: ['client_credentials'], scopes: ['telemetry:write'], isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } },
  { _id: 'demo-web', applicationId: 'demo', name: 'Demo Web', grantTypes: ['password'], isConfidential: false }
];
const users: DumpUser[] = [
  { _id: 'u-demo', email: 'demo@fps4.nl', status: 'active' }
];
const assignments: DumpAssignment[] = [
  { userId: 'u-demo', applicationId: 'demo', roles: ['member'] }
];

describe('dump-seed', () => {
  it('round-trips through parseSeedConfig (applications only, no users)', () => {
    const seed = buildSeed(applications, credentials, users, assignments, { includeUsers: false });
    const yaml = toSeedYaml(seed);
    const reparsed = parseSeedConfig(parseYaml(yaml));

    expect(reparsed.applications.map((a) => a.id)).toEqual(['telemetry', 'demo']);
    const ingest = reparsed.applications[0].credentials![0];
    expect(ingest).toMatchObject({ id: 'telemetry-ingest', isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } });
    // Secrets are never exported, and users are excluded by default.
    expect(ingest.secret).toBeUndefined();
    expect(reparsed.users.length).toBe(0);
  });

  it('warns about every confidential credential dumped without a secret', () => {
    const { warnings } = buildSeed(applications, credentials, users, assignments, { includeUsers: false });
    expect(warnings.some((w) => w.includes('telemetry-ingest') && w.includes('confidential'))).toBe(true);
  });

  it('emits ${ENV} password placeholders and loads once those env vars are set', () => {
    const seed = buildSeed(applications, credentials, users, assignments, { includeUsers: true });
    const yaml = toSeedYaml(seed);
    const envVar = passwordEnvVar('demo@fps4.nl');
    expect(yaml).toContain(`\${${envVar}}`);

    // Unset env → parse throws (eager interpolation); set env → loads cleanly.
    expect(() => parseSeedConfig(parseYaml(yaml), {})).toThrow();
    const cfg = parseSeedConfig(parseYaml(yaml), { [envVar]: 'correct-horse-battery' });
    expect(cfg.users[0]?.email).toBe('demo@fps4.nl');
    // The dumped assignment survives the round-trip keyed on the application (ADR-0020).
    expect(cfg.users[0]?.assignments).toEqual([{ application: 'demo', roles: ['member'] }]);
  });
});
