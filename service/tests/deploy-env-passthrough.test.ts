/**
 * Guards the seam where deployment configuration is silently lost.
 *
 * Compose reads an env file for `${VAR}` INTERPOLATION. That is not the same as putting a variable in
 * the container: the container receives only what the `environment:` block enumerates. So a variable
 * can be set correctly in the env file and still never reach the app — with no error anywhere.
 *
 * That is not a hypothetical. `CORS_ORIGINS` was configured and dropped exactly this way, and because
 * the app treats an empty allow-list as permissive bootstrap, the effect was the opposite of the
 * intent: every browser origin reflected back, with credentials enabled.
 *
 * The check is cheap and fails loudly the moment someone removes the forwarding from the compose
 * files — which is the only reason the class of bug is hard to spot by review. (It used to also cover
 * the committed ds1 deploy config and the secrets the ds1 deploy workflow appended; both are gone with
 * that workflow — fps4/maestro ADR-0017 — so only the compose seam is left to guard.)
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const repoRoot = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf-8');

/**
 * This reads files that live OUTSIDE `service/`, and the production image is built with `service/` as
 * its whole context (`docker/compose.yaml`) while running `npm test` in the Dockerfile. So inside that
 * build the compose file genuinely does not exist, and the check is not just unable to run — it is
 * meaningless there, since nothing in an image can attest to how the compose that starts it is wired.
 * Skipped in that environment, and enforced where it counts: the DoD job, which runs against a full
 * repo checkout.
 */
const hasRepoTree = existsSync(resolve(repoRoot, 'docker/compose.yaml'));

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

describe.skipIf(!hasRepoTree)('deployment config actually reaches the container', () => {
  // Singled out because its failure mode is inverted: unset does not mean "no origins allowed", it means
  // "all origins allowed" (see utils/cors.ts — an empty allow-list is the permissive bootstrap path).
  it('forwards CORS_ORIGINS, whose absence removes the policy rather than tightening it', () => {
    expect(interpolatedByCompose().has('CORS_ORIGINS')).toBe(true);
  });
});
