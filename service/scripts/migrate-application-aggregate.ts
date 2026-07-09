/**
 * ONE-SHOT migration for ADR-0020: fold OAuth clients into APPLICATIONS (one product = one application
 * with a role catalogue, an audience, and typed credentials). Idempotent; `--dry-run` PROPOSES the
 * grouping and writes nothing.
 *
 * What it does:
 *   1. Group every credential (oauth_client) onto a product key (heuristic below, overridable via the
 *      APP_GROUPING env var: `clientId=appId,clientId=appId`). PRINT the proposed grouping for the
 *      operator to confirm before a non-dry run.
 *   2. Create an `applications` doc per group: name, default `audience` (the user-login credential's
 *      audience), and role catalogue (union of the group's credential `roles` from ADR-0019).
 *   3. Set `applicationId` on every credential; keep a per-credential `audience` OVERRIDE only where it
 *      differs from the application default (product runtimes → maestro-workspace); `$unset` the now
 *      redundant credential `roles`.
 *   4. Re-key `assignments` and `invites` from `clientId` → `applicationId` (merging roles if two
 *      credentials of one application shared a user).
 *   5. Operator safeguard (UNCONDITIONAL): ensure an `identity-console` application with `platform_admin`
 *      in its catalogue and admin@identity-service.fps4.nl assigned to it. The workflow verify fails
 *      otherwise.
 *
 *   MONGO_URI=… MONGO_DB_NAME=… [APP_GROUPING="skills-coach-ds1=coach"] npx tsx scripts/migrate-application-aggregate.ts [--dry-run]
 */
import process from 'process';
import { randomUUID } from 'crypto';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';

const DRY_RUN = process.argv.includes('--dry-run');
// Optional prune list (comma-separated client ids): junk/test credentials to delete (with their
// assignments) before grouping, instead of folding them into an application.
const DELETE_CLIENTS = new Set((process.env.DELETE_CLIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const OPERATOR_EMAIL = 'admin@identity-service.fps4.nl';
const CONSOLE_APP = 'identity-console';
const OPERATOR_ROLES = (process.env.ADMIN_OPERATOR_ROLES ?? 'platform_admin').split(',').map((r) => r.trim()).filter(Boolean);
const USER_LOGIN_GRANTS = new Set(['password', 'authorization_code']);

function log(msg: string) { console.log(`[migrate-application-aggregate]${DRY_RUN ? ' (dry-run)' : ''} ${msg}`); }

function parseOverrides(): Map<string, string> {
  const raw = process.env.APP_GROUPING ?? '';
  const map = new Map<string, string>();
  for (const pair of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [clientId, appId] = pair.split('=').map((s) => s.trim());
    if (clientId && appId) map.set(clientId, appId);
  }
  return map;
}

/** Best-guess product key for a credential (overridable via APP_GROUPING). */
function deriveAppId(client: any): string {
  const id: string = client._id;
  if (id === 'identity-console') return 'identity-console';
  if (id === 'identity-admin-mcp' || id === 'identity-service-ds1-runtime') return 'identity-service';
  if (id.endsWith('-web')) return id.slice(0, -4);
  const m = /@([a-z0-9-]+)\./.exec(client.subject ?? '');
  if (m) return m[1];
  return id.replace(/-ds1-runtime$|-ds1$|-runtime$/, '');
}

const titleCase = (id: string) => id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

async function main() {
  const connection = await getMasterConnection();
  const db = connection.db;
  if (!db) throw new Error('no database handle on the master connection');
  const overrides = parseOverrides();

  let clients = await db.collection('oauth_clients').find({}).toArray() as any[];

  // 0) Prune junk/test credentials (DELETE_CLIENTS) + their assignments before grouping.
  if (DELETE_CLIENTS.size) {
    const toDelete = clients.filter((c) => DELETE_CLIENTS.has(c._id));
    for (const c of toDelete) log(`delete credential ${c._id} (${c.name ?? '—'}) + its assignments`);
    if (!DRY_RUN) {
      const ids = toDelete.map((c) => c._id);
      await db.collection('oauth_clients').deleteMany({ _id: { $in: ids } as any });
      await db.collection('assignments').deleteMany({ clientId: { $in: ids } });
      await db.collection('invites').deleteMany({ clientId: { $in: ids } });
    }
    clients = clients.filter((c) => !DELETE_CLIENTS.has(c._id));
  }

  // 1) Group credentials onto application ids.
  const appOf = new Map<string, string>(); // clientId → appId
  const groups = new Map<string, any[]>();  // appId → credentials
  for (const c of clients) {
    const appId = overrides.get(c._id) ?? c.applicationId ?? deriveAppId(c);
    appOf.set(c._id, appId);
    (groups.get(appId) ?? groups.set(appId, []).get(appId)!).push(c);
  }

  log('proposed grouping (clientId → applicationId):');
  for (const [appId, creds] of [...groups].sort()) {
    log(`  ${appId}:  ${creds.map((c) => c._id).join(', ')}`);
  }

  // 2/3) Build + write applications, then set applicationId on credentials.
  for (const [appId, creds] of groups) {
    // Default audience: prefer a user-login credential's audience, else any credential's audience.
    const webCred = creds.find((c) => (c.grantTypes ?? []).some((g: string) => USER_LOGIN_GRANTS.has(g)));
    const audience = webCred?.audience ?? creds.find((c) => c.audience)?.audience ?? undefined;
    // Role catalogue: union of the group's credential catalogues (ADR-0019 field on the client).
    const roleByKey = new Map<string, any>();
    for (const c of creds) for (const r of (c.roles ?? [])) if (r?.key && !roleByKey.has(r.key)) roleByKey.set(r.key, r);
    const roles = [...roleByKey.values()];

    log(`application ${appId}: name="${titleCase(appId)}" audience=${audience ?? '—'} roles=[${roles.map((r) => r.key).join(', ')}] credentials=${creds.length}`);
    if (!DRY_RUN) {
      await db.collection('applications').updateOne(
        { _id: appId as any },
        { $set: { name: titleCase(appId), audience, roles, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      for (const c of creds) {
        const set: any = { applicationId: appId, updatedAt: new Date() };
        const unset: any = { roles: '' }; // catalogue now lives on the application
        // Keep the credential audience only as an override (differs from the app default).
        if (c.audience && c.audience === audience) unset.audience = '';
        await db.collection('oauth_clients').updateOne({ _id: c._id }, { $set: set, $unset: unset });
      }
    }
  }

  // 4) Re-key assignments (clientId → applicationId), merging roles on collision within one app.
  const assignments = await db.collection('assignments').find({}).toArray() as any[];
  const merged = new Map<string, { userId: string; applicationId: string; roles: Set<string>; status: string; keep: any }>();
  for (const a of assignments) {
    const appId = a.applicationId ?? appOf.get(a.clientId);
    if (!appId) { log(`skip assignment ${a._id}: no application for client ${a.clientId}`); continue; }
    const key = `${a.userId} ${appId}`;
    const entry = merged.get(key) ?? { userId: a.userId, applicationId: appId, roles: new Set<string>(), status: 'active', keep: a };
    (a.roles ?? []).forEach((r: string) => entry.roles.add(r));
    if (a.status === 'suspended') entry.status = entry.status === 'active' ? 'active' : 'suspended';
    merged.set(key, entry);
  }
  log(`assignments: ${assignments.length} existing → ${merged.size} application-scoped`);
  if (!DRY_RUN) {
    await db.collection('assignments').deleteMany({});
    for (const e of merged.values()) {
      await db.collection('assignments').insertOne({
        _id: randomUUID(), userId: e.userId, applicationId: e.applicationId,
        roles: [...e.roles], status: e.status, createdBy: 'migrate-application-aggregate',
        createdAt: new Date(), updatedAt: new Date()
      } as any);
    }
  }

  // Re-key invites.
  const invites = await db.collection('invites').find({ clientId: { $exists: true } }).toArray() as any[];
  log(`invites: re-keying ${invites.length} from clientId → applicationId`);
  if (!DRY_RUN) {
    for (const inv of invites) {
      const appId = appOf.get(inv.clientId) ?? inv.clientId;
      await db.collection('invites').updateOne({ _id: inv._id }, { $set: { applicationId: appId }, $unset: { clientId: '' } });
    }
  }

  // 5) Operator safeguard — unconditional.
  const operator = await db.collection('users').findOne({ email: OPERATOR_EMAIL }) as any;
  log(`operator safeguard: ensure ${CONSOLE_APP} app has [${OPERATOR_ROLES.join(', ')}] and ${OPERATOR_EMAIL} is assigned`);
  if (!DRY_RUN) {
    const app = await db.collection('applications').findOne({ _id: CONSOLE_APP as any }) as any;
    const existingRoles: any[] = app?.roles ?? [];
    const byKey = new Map(existingRoles.map((r) => [r.key, r]));
    for (const r of OPERATOR_ROLES) if (!byKey.has(r)) byKey.set(r, { key: r, name: 'Platform Admin' });
    await db.collection('applications').updateOne(
      { _id: CONSOLE_APP as any },
      { $set: { roles: [...byKey.values()], updatedAt: new Date() }, $setOnInsert: { name: 'identity-service admin console', audience: 'identity-console', createdAt: new Date() } },
      { upsert: true }
    );
    if (operator) {
      await db.collection('assignments').updateOne(
        { userId: operator._id, applicationId: CONSOLE_APP },
        { $set: { roles: OPERATOR_ROLES, status: 'active', updatedAt: new Date() }, $setOnInsert: { _id: randomUUID(), userId: operator._id, applicationId: CONSOLE_APP, createdBy: 'migrate-app-safeguard', createdAt: new Date() } },
        { upsert: true }
      );
    } else {
      log(`WARNING: ${OPERATOR_EMAIL} not found — re-seed config/seed.operators.yaml to (re)create the operator + assignment.`);
    }
  }

  // 6) Reconcile indexes to the new schemas.
  if (!DRY_RUN) {
    const models = makeModels(connection);
    for (const name of ['Application', 'OAuthClient', 'Assignment', 'Invite'] as const) {
      await (models[name] as any).syncIndexes();
      log(`syncIndexes: ${name}`);
    }
  }

  log('done.');
}

main()
  .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
  .finally(() => disconnect());
