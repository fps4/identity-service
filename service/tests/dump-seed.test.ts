import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildSeedTenants, toSeedYaml, passwordEnvVar } from '../scripts/dump-seed.js';
import { parseSeedConfig } from '../src/services/seed-config.js';

// A machine (client_credentials) tenant + a human (local IdP) tenant, mirroring real fps4 data.
const tenants = [
  {
    _id: 'telemetry', name: 'Telemetry Platform', status: 'active',
    oauth: { enabled: true, allowedGrantTypes: ['client_credentials'], allowedScopes: ['telemetry:write'] }
  },
  {
    _id: 'demo', name: 'Demo Tenant', status: 'active', allowedOrigins: ['http://localhost:3000'],
    oauth: { enabled: true, allowedGrantTypes: ['password'], allowedRoles: ['member'], idp: { provider: 'local' } }
  }
];
const clientsByTenant = {
  telemetry: [{ _id: 'telemetry-ingest', name: 'Ingest', grantTypes: ['client_credentials'], scopes: ['telemetry:write'], isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } }],
  demo: [{ _id: 'demo-web', name: 'Demo Web', grantTypes: ['password'], audience: 'demo-workspace', isConfidential: false }]
};
const usersByTenant = {
  demo: [{ email: 'demo@fps4.nl', status: 'active', roles: ['member'] }],
  telemetry: []
};

describe('dump-seed', () => {
  it('round-trips through parseSeedConfig (clients only, no users)', () => {
    const { tenants: out } = buildSeedTenants(tenants, clientsByTenant, usersByTenant, { includeUsers: false });
    const yaml = toSeedYaml(out);
    const reparsed = parseSeedConfig(parseYaml(yaml));

    expect(reparsed.tenants.map((t) => t.id)).toEqual(['telemetry', 'demo']);
    const ingest = reparsed.tenants[0].clients?.[0];
    expect(ingest).toMatchObject({ id: 'telemetry-ingest', isConfidential: true, subject: 'runtime', claims: { role: 'product_runtime' } });
    // Secrets are never exported, and users are excluded by default.
    expect(ingest?.secret).toBeUndefined();
    expect(reparsed.tenants.every((t) => (t.users?.length ?? 0) === 0)).toBe(true);
  });

  it('warns about every confidential client dumped without a secret', () => {
    const { warnings } = buildSeedTenants(tenants, clientsByTenant, usersByTenant, { includeUsers: false });
    expect(warnings.some((w) => w.includes('telemetry-ingest') && w.includes('confidential'))).toBe(true);
  });

  it('emits ${ENV} password placeholders and loads once those env vars are set', () => {
    const { tenants: out } = buildSeedTenants(tenants, clientsByTenant, usersByTenant, { includeUsers: true });
    const yaml = toSeedYaml(out);
    const envVar = passwordEnvVar('demo', 'demo@fps4.nl');
    expect(yaml).toContain(`\${${envVar}}`);

    // Unset env → parse throws (eager interpolation); set env → loads cleanly.
    expect(() => parseSeedConfig(parseYaml(yaml), {})).toThrow();
    const cfg = parseSeedConfig(parseYaml(yaml), { [envVar]: 'correct-horse-battery' });
    expect(cfg.tenants.find((t) => t.id === 'demo')?.users?.[0]?.email).toBe('demo@fps4.nl');
  });
});
