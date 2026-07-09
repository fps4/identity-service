/**
 * ONE-SHOT migration for ADR-0018: collapse Tenant into Deployment (one realm / one user pool).
 *
 * Removes the `tenantId` field from every collection, drops the `tenants` collection, and rebuilds
 * indexes so `users.email` is globally unique (was unique per {tenantId,email}). Idempotent: safe to
 * re-run — a second run finds nothing to unset and reconciles the same indexes.
 *
 * ds1 posture (ADR-0018 precondition): a deployment holds ONE user pool. If the live DB accreted several
 * former tenants that share an email, the new unique {email} index cannot build. We are explicitly NOT
 * preserving cross-tenant history (the migration was authorised to break it): this script DEDUPES users
 * by email — keeping the most recently active/created account and deleting the rest — and logs every
 * dropped account, then does the same for any colliding federated identity {provider, subject}.
 *
 *   cd service
 *   MONGO_URI=mongodb://localhost:27019 MONGO_DB_NAME=identity-service npx tsx scripts/migrate-drop-tenant.ts
 *   # add --dry-run to report what it WOULD change without writing.
 *
 * Runs against the live DB (the system of record, ADR-0008). Take a backup first (docker/backup.sh).
 */
import process from 'process';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';

const DRY_RUN = process.argv.includes('--dry-run');
const TENANTED_COLLECTIONS = [
  'users', 'oauth_clients', 'oauth_tokens', 'oauth_authorizations', 'invites', 'sessions', 'key_store'
];

function log(msg: string) { console.log(`[migrate-drop-tenant]${DRY_RUN ? ' (dry-run)' : ''} ${msg}`); }

/** Pick the account to KEEP among duplicates: most recent lastLoginAt, else createdAt, else _id order. */
function rank(a: any, b: any): number {
  const t = (d: any) => new Date(d?.lastLoginAt ?? d?.createdAt ?? 0).getTime();
  return t(b) - t(a);
}

async function dedupeUsers(db: any): Promise<void> {
  const users = await db.collection('users').find({}).toArray();
  const byEmail = new Map<string, any[]>();
  for (const u of users) {
    const key = String(u.email ?? '').toLowerCase();
    (byEmail.get(key) ?? byEmail.set(key, []).get(key)!).push(u);
  }
  let dropped = 0;
  for (const [email, group] of byEmail) {
    if (group.length <= 1) continue;
    group.sort(rank);
    const [keep, ...remove] = group;
    log(`email "${email}": ${group.length} accounts across former tenants — keeping ${keep._id} (tenant ${keep.tenantId ?? '—'}), dropping ${remove.length}`);
    for (const r of remove) {
      log(`  drop user ${r._id} (tenant ${r.tenantId ?? '—'})`);
      if (!DRY_RUN) await db.collection('users').deleteOne({ _id: r._id });
      dropped++;
    }
  }
  log(`user email dedupe: ${dropped} account(s) removed`);

  // Federated identity collisions {provider, subject} across former tenants (rare) — same policy.
  const remaining = await db.collection('users').find({ 'identities.0': { $exists: true } }).toArray();
  const bySubject = new Map<string, any[]>();
  for (const u of remaining) {
    for (const idn of u.identities ?? []) {
      const key = `${idn.provider}:${idn.subject}`;
      (bySubject.get(key) ?? bySubject.set(key, []).get(key)!).push(u);
    }
  }
  let idDropped = 0;
  for (const [key, group] of bySubject) {
    const uniq = [...new Map(group.map((g) => [String(g._id), g])).values()];
    if (uniq.length <= 1) continue;
    uniq.sort(rank);
    const [, ...remove] = uniq;
    log(`identity ${key}: linked to ${uniq.length} users — dropping ${remove.length}`);
    for (const r of remove) {
      if (!DRY_RUN) await db.collection('users').deleteOne({ _id: r._id });
      idDropped++;
    }
  }
  if (idDropped) log(`federated-identity dedupe: ${idDropped} account(s) removed`);
}

async function main() {
  const connection = await getMasterConnection();
  const db = connection.db;
  if (!db) throw new Error('no database handle on the master connection');

  // 1) Resolve email/identity collisions BEFORE building the new unique indexes.
  await dedupeUsers(db);

  // 2) Strip tenantId from every collection, and principalTenantId from audit_logs.
  for (const coll of TENANTED_COLLECTIONS) {
    const res = DRY_RUN
      ? { modifiedCount: await db.collection(coll).countDocuments({ tenantId: { $exists: true } }) }
      : await db.collection(coll).updateMany({ tenantId: { $exists: true } }, { $unset: { tenantId: '' } });
    log(`${coll}: unset tenantId on ${res.modifiedCount} doc(s)`);
  }
  const auditRes = DRY_RUN
    ? { modifiedCount: await db.collection('audit_logs').countDocuments({ principalTenantId: { $exists: true } }) }
    : await db.collection('audit_logs').updateMany({ principalTenantId: { $exists: true } }, { $unset: { principalTenantId: '' } });
  log(`audit_logs: unset principalTenantId on ${auditRes.modifiedCount} doc(s)`);

  // 3) Drop the tenants collection — it is no longer a modelled entity.
  const collections = await db.listCollections({ name: 'tenants' }).toArray();
  if (collections.length) {
    log('dropping the `tenants` collection');
    if (!DRY_RUN) await db.dropCollection('tenants');
  } else {
    log('`tenants` collection already absent');
  }

  // 4) Reconcile indexes to the new schemas: drops the stale {tenantId,...} indexes and builds the new
  //    globally-unique {email} + {identities.provider,subject} indexes. Deduped above so this cannot fail.
  if (!DRY_RUN) {
    const models = makeModels(connection);
    for (const [name, model] of Object.entries(models)) {
      try {
        await (model as any).syncIndexes();
        log(`syncIndexes: ${name}`);
      } catch (err) {
        log(`syncIndexes FAILED for ${name}: ${(err as Error).message}`);
        throw err;
      }
    }
  } else {
    log('skipping syncIndexes (dry-run)');
  }

  log('done.');
}

main()
  .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
  .finally(() => disconnect());
