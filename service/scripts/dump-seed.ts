/**
 * Seed export — the write-back half of the operating model (ADR-0011, RQ-0004). Serializes the
 * tenants + OAuth clients currently in Mongo into a seed.yaml-shaped document, so changes made
 * through the admin console / API can be captured back into version-controlled config (commit the
 * output) and survive a rebuild-from-seed. The inverse of `scripts/seed.ts`.
 *
 *   cd service
 *   npm run dump-seed                       # whole DB → stdout
 *   npm run dump-seed -- --out=../config/seed.yaml
 *   npm run dump-seed -- --tenant=demo      # one tenant only
 *   npm run dump-seed -- --include-users    # also emit users (with ${ENV} password placeholders)
 *
 * SECRETS ARE NOT RECOVERABLE. Client secrets and user passwords are stored only as one-way hashes,
 * so they cannot be exported:
 *   - Clients are dumped WITHOUT `secret`. Re-running seed against the SAME db preserves each client's
 *     existing secretHash (the loader only writes secretHash when `secret:` is present), so this is a
 *     lossless round-trip for live data. For a FRESH-db rebuild, a confidential client with no secret
 *     would come up with no usable secret — add a `secret: ${ENV_VAR}` to its entry first. The script
 *     warns about every confidential client it dumps without a secret.
 *   - Users are omitted by default (passwords unrecoverable + emails are PII). `--include-users` emits
 *     them with `password: ${SEED_<TENANT>_<USER>_PASSWORD}` placeholders you must set in the env
 *     before that file can be loaded.
 */
import process from 'process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';

interface Flags { out?: string; tenant?: string; includeUsers: boolean }

function parseFlags(): Flags {
  const args = process.argv.slice(2);
  const get = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  return { out: get('out'), tenant: get('tenant'), includeUsers: args.includes('--include-users') };
}

/** Minimal shapes the builder needs from the lean Mongo docs (kept loose so tests need no real models). */
export interface DumpTenant { _id: string; name: string; status?: string; allowedOrigins?: string[]; oauth?: Record<string, unknown> }
export interface DumpClient { _id: string; name?: string; grantTypes?: string[]; audience?: string; redirectUris?: string[]; scopes?: string[]; isConfidential?: boolean; subject?: string; claims?: Record<string, unknown> }
export interface DumpUser { email: string; status?: string; roles?: string[] }

/** Drop undefined / empty-array keys so the emitted YAML stays close to a hand-written seed file. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Stable, uppercase env-var name for a user's password placeholder. */
export function passwordEnvVar(tenantId: string, email: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `SEED_${slug(tenantId)}_${slug(email.split('@')[0])}_PASSWORD`;
}

/**
 * Pure transform: turn live tenants + their clients/users into seed.yaml-shaped tenant objects, plus
 * any operator warnings. Exported (no I/O) so it round-trips through parseSeedConfig under test.
 */
export function buildSeedTenants(
  tenants: DumpTenant[],
  clientsByTenant: Record<string, DumpClient[]>,
  usersByTenant: Record<string, DumpUser[]>,
  opts: { includeUsers: boolean }
): { tenants: Record<string, unknown>[]; warnings: string[] } {
  const warnings: string[] = [];
  const outTenants = tenants.map((t) => {
    const dumpedClients = (clientsByTenant[t._id] ?? []).map((c) => {
      if (c.isConfidential) {
        warnings.push(`client '${c._id}' (tenant ${t._id}) is confidential but dumped without a secret — add secret: \${ENV} before a fresh-db rebuild`);
      }
      return compact({
        id: c._id,
        name: c.name,
        grantTypes: c.grantTypes,
        audience: c.audience,
        redirectUris: c.redirectUris,
        scopes: c.scopes,
        isConfidential: c.isConfidential,
        subject: c.subject,
        claims: c.claims && Object.keys(c.claims).length ? c.claims : undefined
        // secret intentionally omitted — see file header.
      });
    });

    let dumpedUsers: Record<string, unknown>[] | undefined;
    if (opts.includeUsers) {
      dumpedUsers = (usersByTenant[t._id] ?? []).map((u) => {
        warnings.push(`user '${u.email}' (tenant ${t._id}) dumped with a \${${passwordEnvVar(t._id, u.email)}} placeholder — set it in the env before loading`);
        return compact({
          email: u.email,
          password: `\${${passwordEnvVar(t._id, u.email)}}`,
          status: u.status,
          roles: u.roles
        });
      });
    }

    const oauth = t.oauth ?? {};
    return compact({
      id: t._id,
      name: t.name,
      status: t.status,
      allowedOrigins: t.allowedOrigins,
      oauth: compact({
        enabled: oauth.enabled ?? false,
        allowedGrantTypes: oauth.allowedGrantTypes ?? [],
        allowedScopes: oauth.allowedScopes,
        allowedRoles: oauth.allowedRoles,
        idp: oauth.idp,
        limits: oauth.limits
      }),
      clients: dumpedClients,
      users: dumpedUsers
    });
  });
  return { tenants: outTenants, warnings };
}

const HEADER =
  '# Generated by `npm run dump-seed` — a snapshot of the tenants/clients currently in the database.\n' +
  '# Client secrets and user passwords are NOT included (they are stored only as one-way hashes).\n' +
  '# Review, add any `secret: ${ENV}` refs needed for a fresh-db rebuild, then commit.\n\n';

/** Serialize built tenant objects to a seed.yaml document (header comment + YAML body). */
export function toSeedYaml(tenants: Record<string, unknown>[]): string {
  return HEADER + stringify({ tenants });
}

async function main() {
  const flags = parseFlags();
  const connection = await getMasterConnection();
  const { Tenant, OAuthClient, User } = makeModels(connection);

  const tenantFilter = flags.tenant ? { _id: flags.tenant } : {};
  const tenants = await Tenant.find(tenantFilter).sort({ _id: 1 }).lean().exec();
  if (!tenants.length) throw new Error(flags.tenant ? `No tenant '${flags.tenant}'` : 'No tenants in the database');

  const clientsByTenant: Record<string, DumpClient[]> = {};
  const usersByTenant: Record<string, DumpUser[]> = {};
  for (const t of tenants) {
    clientsByTenant[t._id] = await OAuthClient.find({ tenantId: t._id }).sort({ _id: 1 }).lean().exec() as unknown as DumpClient[];
    if (flags.includeUsers) {
      usersByTenant[t._id] = await User.find({ tenantId: t._id }).sort({ email: 1 }).lean().exec() as unknown as DumpUser[];
    }
  }

  const { tenants: outTenants, warnings } = buildSeedTenants(
    tenants as unknown as DumpTenant[], clientsByTenant, usersByTenant, { includeUsers: flags.includeUsers }
  );
  const yamlBody = toSeedYaml(outTenants);

  if (flags.out) {
    writeFileSync(flags.out, yamlBody, 'utf-8');
    console.error(`dump-seed: wrote ${outTenants.length} tenant(s) to ${flags.out}`);
  } else {
    process.stdout.write(yamlBody);
  }
  for (const w of warnings) console.error(`  warn: ${w}`);
}

// Only hit the database when run as a script — importing the pure helpers (tests) must not connect.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
    .finally(() => disconnect());
}
