import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildSeed, toSeedYaml, passwordEnvVar, type DumpClient, type DumpUser } from '../scripts/dump-seed.js';
import { parseSeedConfig } from '../src/services/seed-config.js';

// A flat set of live clients + users (ADR-0018: one deployment = one realm, no tenant grouping):
// a machine (client_credentials) client and a human (password) client, plus a local user.
const clients: DumpClient[] = [
  { _id: 'telemetry-ingest', name: 'Ingest', grantTypes: ['client_credentials'], scopes: ['telemetry:write'], isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } },
  { _id: 'demo-web', name: 'Demo Web', grantTypes: ['password'], audience: 'demo-workspace', isConfidential: false }
];
const users: DumpUser[] = [
  { email: 'demo@fps4.nl', status: 'active', roles: ['member'] }
];

describe('dump-seed', () => {
  it('round-trips through parseSeedConfig (clients only, no users)', () => {
    const seed = buildSeed(clients, users, { includeUsers: false });
    const yaml = toSeedYaml(seed);
    const reparsed = parseSeedConfig(parseYaml(yaml));

    expect(reparsed.clients.map((c) => c.id)).toEqual(['telemetry-ingest', 'demo-web']);
    const ingest = reparsed.clients[0];
    expect(ingest).toMatchObject({ id: 'telemetry-ingest', isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } });
    // Secrets are never exported, and users are excluded by default.
    expect(ingest.secret).toBeUndefined();
    expect(reparsed.users.length).toBe(0);
  });

  it('warns about every confidential client dumped without a secret', () => {
    const { warnings } = buildSeed(clients, users, { includeUsers: false });
    expect(warnings.some((w) => w.includes('telemetry-ingest') && w.includes('confidential'))).toBe(true);
  });

  it('emits ${ENV} password placeholders and loads once those env vars are set', () => {
    const seed = buildSeed(clients, users, { includeUsers: true });
    const yaml = toSeedYaml(seed);
    const envVar = passwordEnvVar('demo@fps4.nl');
    expect(yaml).toContain(`\${${envVar}}`);

    // Unset env → parse throws (eager interpolation); set env → loads cleanly.
    expect(() => parseSeedConfig(parseYaml(yaml), {})).toThrow();
    const cfg = parseSeedConfig(parseYaml(yaml), { [envVar]: 'correct-horse-battery' });
    expect(cfg.users[0]?.email).toBe('demo@fps4.nl');
  });
});
