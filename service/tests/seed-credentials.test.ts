import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { credentialUpdate } from '../scripts/seed.js';
import { verifySecret } from '../src/utils/hash.js';
import { parseSeedConfig, type SeedCredential } from '../src/services/seed-config.js';

// ADR-0021: a seed run reconciles a credential's STRUCTURE on every pass but writes its SECRET only on
// insert. These pin the property that made the old behaviour dangerous — a re-seed silently reverting a
// rotation — rather than the shape of the update object for its own sake.

const now = new Date('2026-08-07T00:00:00Z');
const machine: SeedCredential = {
  id: 'skills-coach-coach',
  name: 'Skills Coach — coach automation',
  grantTypes: ['client_credentials'],
  isConfidential: true,
  subject: 'coach@skills-coach.fps4.nl',
  claims: { roles: ['coach'] }
};

describe('seed credential upsert (ADR-0021)', () => {
  it('never puts secretHash in $set, so a re-seed cannot overwrite a rotated secret', () => {
    const withSecret = credentialUpdate({ ...machine, secret: 'from-config' }, 'skills-coach', now);
    expect(withSecret.$set).not.toHaveProperty('secretHash');
    expect(withSecret.$setOnInsert).toHaveProperty('secretHash');
    // $setOnInsert applies only when the upsert inserts — an existing credential keeps its live hash.
    expect(verifySecret('from-config', withSecret.$setOnInsert!.secretHash as string)).toBe(true);
  });

  it('gives a confidential credential declared with no secret an unguessable hash nobody holds', () => {
    const a = credentialUpdate(machine, 'skills-coach', now);
    const b = credentialUpdate(machine, 'skills-coach', now);
    expect(a.$setOnInsert).toHaveProperty('secretHash');
    // Random per call, so it is not derivable from the config the way a fixed placeholder would be.
    expect(a.$setOnInsert!.secretHash).not.toBe(b.$setOnInsert!.secretHash);
    // The credential exists but cannot authenticate until rotate_client_secret issues a real value.
    expect(verifySecret('', a.$setOnInsert!.secretHash as string)).toBe(false);
  });

  it('writes no secretHash at all for a public client', () => {
    const web: SeedCredential = { id: 'skills-coach-web', grantTypes: ['password'], isConfidential: false };
    expect(credentialUpdate(web, 'skills-coach', now).$setOnInsert).toBeUndefined();
  });

  it('keeps structure in $set so a re-seed still reconciles it', () => {
    const { $set } = credentialUpdate({ ...machine, redirectUris: ['http://localhost:9415/callback'] }, 'skills-coach', now);
    expect($set).toMatchObject({
      applicationId: 'skills-coach',
      grantTypes: ['client_credentials'],
      redirectUris: ['http://localhost:9415/callback'],
      subject: 'coach@skills-coach.fps4.nl',
      claims: { roles: ['coach'] },
      isConfidential: true,
      updatedAt: now
    });
  });

  it('omits subject and claims entirely when the config does not set them', () => {
    const { $set } = credentialUpdate({ id: 'x', grantTypes: ['password'] }, 'app', now);
    expect($set).not.toHaveProperty('subject');
    expect($set).not.toHaveProperty('claims');
  });
});

// The committed seed files themselves, not just the loader. A `secret: ${…}` reintroduced by a future PR
// would compile, pass every other test, and quietly restore the coupling ADR-0021 removed: the value's
// system of record back in this repo's CI, and a deploy that fails closed when it is unset.
describe('committed seed files reference no product secrets (ADR-0021)', () => {
  const dir = fileURLToPath(new URL('../../config/', import.meta.url));
  // Only the bootstrap pair may remain — minting a credential needs an admin credential to exist first,
  // and the first operator needs a password before anyone can log in to create the rest.
  const BOOTSTRAP = new Set(['IDENTITY_ADMIN_CLIENT_SECRET', 'SEED_CONSOLE_ADMIN_PASSWORD']);
  // seed.example.yaml is documentation of the schema, not a file the workflow ever applies.
  const files = readdirSync(dir).filter((f) => /^seed\..*\.yaml$|^seed\.yaml$/.test(f) && f !== 'seed.example.yaml');

  it('finds the seed files it is meant to be checking', () => {
    expect(files).toContain('seed.yaml');
    expect(files).toContain('seed.skills-coach.yaml');
  });

  it.each(files)('%s references only bootstrap secrets', (file) => {
    // Comment lines are prose — several spell `${ENV_VAR}` while explaining the interpolation rule, and
    // the loader never resolves those. Only what YAML actually parses counts.
    const yamlOnly = readFileSync(dir + file, 'utf-8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    const referenced = [...yamlOnly.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
    expect(referenced.filter((v) => !BOOTSTRAP.has(v))).toEqual([]);
  });

  // The loader validates every ${…} reference up front and aborts the whole run on the first unset one,
  // so a file that fails to parse is only discovered mid-deploy. Parse them here instead.
  it.each(files)('%s parses with only the bootstrap env set', (file) => {
    const env = { IDENTITY_ADMIN_CLIENT_SECRET: 'x'.repeat(32), SEED_CONSOLE_ADMIN_PASSWORD: 'Str0ng!Passw0rd-x' };
    const config = parseSeedConfig(parseYaml(readFileSync(dir + file, 'utf-8')), env);
    const credentials = config.applications.flatMap((a) => a.credentials ?? []);
    // Whatever resolved a secret must be a bootstrap credential — nothing else may carry one.
    expect(credentials.filter((c) => c.secret).map((c) => c.id)).toEqual(
      file === 'seed.yaml' ? ['identity-admin-mcp'] : []
    );
  });

  it.each(files)('%s declares no credential secret at all', (file) => {
    const withSecret = readFileSync(dir + file, 'utf-8')
      .split('\n')
      .filter((l) => /^\s*secret:/.test(l) && !l.trimStart().startsWith('#'));
    // seed.yaml's one exemption is the admin credential that cannot bootstrap itself.
    expect(withSecret.length).toBe(file === 'seed.yaml' ? 1 : 0);
  });
});
