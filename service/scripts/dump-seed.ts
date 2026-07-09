/**
 * Seed export — the write-back half of the operating model (ADR-0011, RQ-0004, ADR-0020). Serializes the
 * APPLICATIONS currently in Mongo (each with its role catalogue, audience, and credentials) into a
 * seed.yaml-shaped document, so changes made through the admin console / API can be captured back into
 * version-controlled config and survive a rebuild-from-seed. The inverse of `scripts/seed.ts`.
 *
 *   cd service
 *   npm run dump-seed                       # whole DB → stdout
 *   npm run dump-seed -- --out=../config/seed.yaml
 *   npm run dump-seed -- --include-users    # also emit users (with ${ENV} password placeholders)
 *
 * SECRETS ARE NOT RECOVERABLE (one-way hashes). Credentials are dumped WITHOUT `secret`; a confidential
 * credential needs a `secret: ${ENV}` added before a fresh-db rebuild (the script warns). Users are
 * omitted by default; `--include-users` emits them with `${SEED_<USER>_PASSWORD}` placeholders and their
 * per-application assignments.
 */
import process from 'process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';

interface Flags { out?: string; includeUsers: boolean }

function parseFlags(): Flags {
  const args = process.argv.slice(2);
  const get = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  return { out: get('out'), includeUsers: args.includes('--include-users') };
}

/** Minimal shapes the builder needs from the lean Mongo docs (kept loose so tests need no real models). */
export interface DumpAppRole { key: string; name?: string; description?: string }
export interface DumpApplication { _id: string; name?: string; audience?: string; roles?: DumpAppRole[] }
export interface DumpCredential { _id: string; applicationId?: string; name?: string; grantTypes?: string[]; audience?: string; redirectUris?: string[]; scopes?: string[]; isConfidential?: boolean; subject?: string; claims?: Record<string, unknown> }
export interface DumpUser { _id: string; email: string; status?: string }
export interface DumpAssignment { userId: string; applicationId: string; roles?: string[] }

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
export function passwordEnvVar(email: string): string {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `SEED_${slug(email.split('@')[0])}_PASSWORD`;
}

/**
 * Pure transform: turn live applications + credentials + users + assignments into seed.yaml-shaped
 * objects, plus operator warnings. Exported (no I/O) so it round-trips through parseSeedConfig under test.
 */
export function buildSeed(
  applications: DumpApplication[],
  credentials: DumpCredential[],
  users: DumpUser[],
  assignments: DumpAssignment[],
  opts: { includeUsers: boolean }
): { applications: Record<string, unknown>[]; users: Record<string, unknown>[]; warnings: string[] } {
  const warnings: string[] = [];
  const credsByApp = new Map<string, DumpCredential[]>();
  for (const c of credentials) {
    const key = c.applicationId ?? '';
    (credsByApp.get(key) ?? credsByApp.set(key, []).get(key)!).push(c);
  }

  const dumpedApps = applications.map((app) => compact({
    id: app._id,
    name: app.name,
    audience: app.audience,
    roles: app.roles && app.roles.length ? app.roles.map((r) => compact({ key: r.key, name: r.name, description: r.description })) : undefined,
    credentials: (credsByApp.get(app._id) ?? []).map((c) => {
      if (c.isConfidential) {
        warnings.push(`credential '${c._id}' (app ${app._id}) is confidential but dumped without a secret — add secret: \${ENV} before a fresh-db rebuild`);
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
    })
  }));

  let dumpedUsers: Record<string, unknown>[] = [];
  if (opts.includeUsers) {
    const asgByUser = new Map<string, DumpAssignment[]>();
    for (const a of assignments) (asgByUser.get(a.userId) ?? asgByUser.set(a.userId, []).get(a.userId)!).push(a);
    dumpedUsers = users.map((u) => {
      warnings.push(`user '${u.email}' dumped with a \${${passwordEnvVar(u.email)}} placeholder — set it in the env before loading`);
      return compact({
        email: u.email,
        password: `\${${passwordEnvVar(u.email)}}`,
        status: u.status,
        assignments: (asgByUser.get(u._id) ?? []).map((a) => compact({ application: a.applicationId, roles: a.roles }))
      });
    });
  }

  return { applications: dumpedApps, users: dumpedUsers, warnings };
}

const HEADER =
  '# Generated by `npm run dump-seed` — a snapshot of the applications + credentials currently in the DB.\n' +
  '# Credential secrets and user passwords are NOT included (they are stored only as one-way hashes).\n' +
  '# Review, add any `secret: ${ENV}` refs needed for a fresh-db rebuild, then commit.\n\n';

/** Serialize built applications/users to a seed.yaml document (header comment + YAML body). */
export function toSeedYaml(seed: { applications: Record<string, unknown>[]; users: Record<string, unknown>[] }): string {
  const body: Record<string, unknown> = { applications: seed.applications };
  if (seed.users.length) body.users = seed.users;
  return HEADER + stringify(body);
}

async function main() {
  const flags = parseFlags();
  const connection = await getMasterConnection();
  const { Application, OAuthClient, User, Assignment } = makeModels(connection);

  const applications = await Application.find().sort({ _id: 1 }).lean().exec() as unknown as DumpApplication[];
  const credentials = await OAuthClient.find().sort({ _id: 1 }).lean().exec() as unknown as DumpCredential[];
  const users = flags.includeUsers ? await User.find().sort({ email: 1 }).lean().exec() as unknown as DumpUser[] : [];
  const assignments = flags.includeUsers ? await Assignment.find().lean().exec() as unknown as DumpAssignment[] : [];

  const { applications: outApps, users: outUsers, warnings } = buildSeed(applications, credentials, users, assignments, { includeUsers: flags.includeUsers });
  const yamlBody = toSeedYaml({ applications: outApps, users: outUsers });

  if (flags.out) {
    writeFileSync(flags.out, yamlBody, 'utf-8');
    console.error(`dump-seed: wrote ${outApps.length} application(s) to ${flags.out}`);
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
