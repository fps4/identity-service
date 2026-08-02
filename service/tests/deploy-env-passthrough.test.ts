/**
 * Guards the seam where deployment configuration is silently lost.
 *
 * `config/ds1/.env.base` (plus the secrets the deploy workflow appends) becomes `config/ds1/.env`, which
 * compose reads for `${VAR}` INTERPOLATION. That is not the same as putting a variable in the container:
 * the container receives only what the `environment:` block enumerates. So a variable can be set
 * correctly in the committed config, written correctly by the workflow, and still never reach the app —
 * with no error anywhere.
 *
 * That is not a hypothetical. `CORS_ORIGINS` was configured and dropped exactly this way, and because
 * the app treats an empty allow-list as permissive bootstrap, the effect was the opposite of the
 * intent: every browser origin reflected back, with credentials enabled. `AUTH_REGISTRATION_MODE`,
 * `AUTH_LOCAL_IDP_ENABLED` and all three `GOOGLE_*` secrets were being dropped alongside it.
 *
 * These tests are cheap and they fail loudly the moment someone adds a knob to the deployment config
 * without wiring it through — which is the only reason the class of bug is hard to spot by review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf-8');

/** The variable names compose interpolates, i.e. everything it can actually forward. */
function interpolatedByCompose(): Set<string> {
  const composeFiles = ['docker/compose.yaml', 'docker/compose.prod.yaml', 'docker/compose.dev.yaml'];
  const names = new Set<string>();
  for (const f of composeFiles) {
    let text: string;
    try { text = read(f); } catch { continue; }
    for (const m of text.matchAll(/\$\{([A-Z0-9_]+)/g)) names.add(m[1]);
  }
  return names;
}

/** `KEY=value` assignments in an env file, ignoring comments and blanks. */
function keysOf(envFile: string): string[] {
  return read(envFile)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim())
    .filter((k) => /^[A-Z0-9_]+$/.test(k));
}

describe('deployment config actually reaches the container', () => {
  it('forwards every variable set in config/ds1/.env.base', () => {
    const passed = interpolatedByCompose();
    const dropped = keysOf('config/ds1/.env.base').filter((k) => !passed.has(k));

    expect(dropped, `Set in config/ds1/.env.base but never passed into the container: ${dropped.join(', ')}`)
      .toEqual([]);
  });

  it('forwards every secret the deploy workflow injects', () => {
    const passed = interpolatedByCompose();
    const workflow = read('.github/workflows/deploy-ds1.yml');

    // The names the assemble step appends to config/ds1/.env, i.e. `echo "NAME=$NAME"`.
    const injected = [...workflow.matchAll(/echo\s+"([A-Z0-9_]+)=\$/g)].map((m) => m[1]);
    expect(injected.length).toBeGreaterThan(0); // the regex still matches the workflow's shape

    const dropped = injected.filter((k) => !passed.has(k));
    expect(dropped, `Injected by deploy-ds1.yml but never passed into the container: ${dropped.join(', ')}`)
      .toEqual([]);
  });

  // Singled out because its failure mode is inverted: unset does not mean "no origins allowed", it means
  // "all origins allowed" (see utils/cors.ts — an empty allow-list is the permissive bootstrap path).
  it('forwards CORS_ORIGINS, whose absence removes the policy rather than tightening it', () => {
    expect(interpolatedByCompose().has('CORS_ORIGINS')).toBe(true);
  });
});
