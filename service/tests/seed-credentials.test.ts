import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
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

// A realm's seed is its tenant's (maestro ADR-0017): fps4's lives in maestro-fps4, and the ds1 realm's files
// went with that realm. The only seed this repository commits is the template, so a realm's seed — with the
// credentials and people it names — cannot creep back in here unnoticed.
//
// This reads `config/`, which lives OUTSIDE `service/` — and the production image is built with `service/` as
// its whole context while running `npm test` in the Dockerfile, so the directory genuinely does not exist
// there. Skipped in that environment and enforced where it counts: the DoD job, which runs against a full
// repo checkout. Same seam, and same reasoning, as tests/deploy-env-passthrough.ts.
const dir = fileURLToPath(new URL('../../config/', import.meta.url));
const hasRepoTree = existsSync(dir);

describe.skipIf(!hasRepoTree)('the repository commits no realm\'s seed', () => {
  it('holds only the template in config/', () => {
    const seeds = readdirSync(dir).filter((f) => /^seed(\..*)?\.yaml$/.test(f));
    // config/seed.yaml may exist in a working tree as the gitignored local copy; it is never committed.
    expect(seeds.filter((f) => f !== 'seed.yaml')).toEqual(['seed.example.yaml']);
  });

  it('keeps the template loadable with placeholder values', () => {
    const env = new Proxy({}, { get: () => 'placeholder-Str0ng!-value' }) as Record<string, string>;
    const config = parseSeedConfig(parseYaml(readFileSync(dir + 'seed.example.yaml', 'utf-8')), env);
    expect(config.applications.length).toBeGreaterThan(0);
  });
});
