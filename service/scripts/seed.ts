/**
 * Idempotent seed loader (RQ-0004, ADR-0018). Reads a gitignored YAML config of OAuth clients + local
 * users (one deployment = one realm, so no tenant layer) and upserts them into Mongo. Operator-run
 * (NOT an HTTP endpoint — ADR-0003); the only secret it needs is the Mongo connection from the environment.
 *
 *   cd service
 *   npm run seed                       # reads ../config/seed.yaml
 *   npm run seed -- --file=/abs/path   # explicit file
 *
 * MONGO_URI / MONGO_DB_NAME come from the environment (.env), same as the service. Re-running is
 * safe: tenants and clients are upserted; existing users are left untouched (insert-if-absent), so a
 * re-run never resets a password — use `manage-users set-password` to change one.
 */
import process from 'process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';
import { hashSecret } from '../src/utils/hash.js';
import { parseSeedConfig } from '../src/services/seed-config.js';
import { assertPasswordPolicy } from '../src/services/users.js';

function resolveFile(): string {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--file='));
  if (arg) return arg.slice('--file='.length);
  if (process.env.SEED_FILE) return process.env.SEED_FILE;
  return new URL('../../config/seed.yaml', import.meta.url).pathname; // repo-root/config/seed.yaml
}

async function main() {
  const file = resolveFile();
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`Seed file not found: ${file} (copy config/seed.example.yaml to config/seed.yaml)`);
  }

  const config = parseSeedConfig(parseYaml(text), process.env);
  // Fail fast on weak passwords before touching the DB.
  for (const u of config.users) assertPasswordPolicy(u.password);

  const connection = await getMasterConnection();
  const { Application, OAuthClient, User, Assignment } = makeModels(connection);
  const now = new Date();
  let appsUpserted = 0, clientsUpserted = 0, usersCreated = 0, usersSkipped = 0, assignmentsUpserted = 0;

  for (const app of config.applications) {
    // The application owns its name, default audience, and role catalogue (ADR-0020).
    await Application.updateOne(
      { _id: app.id },
      { $set: { name: app.name, audience: app.audience, roles: app.roles ?? [], updatedAt: now } },
      { upsert: true }
    ).exec();
    appsUpserted++;

    // Each credential (OAuth client) under the application.
    for (const c of app.credentials ?? []) {
      const set: Record<string, unknown> = {
        applicationId: app.id, name: c.name, grantTypes: c.grantTypes,
        redirectUris: c.redirectUris, scopes: c.scopes, audience: c.audience,
        isConfidential: c.isConfidential, updatedAt: now
      };
      // A client-credentials machine principal (US-0086): the runtime subject + additive claims.
      if (c.subject !== undefined) set.subject = c.subject;
      if (c.claims !== undefined) set.claims = c.claims;
      if (c.secret) set.secretHash = hashSecret(c.secret);
      await OAuthClient.updateOne({ _id: c.id }, { $set: set }, { upsert: true }).exec();
      clientsUpserted++;
    }
  }

  for (const u of config.users) {
    // Never clobber an existing account's credentials on re-run, but always reconcile its assignments
    // below (idempotent) — this is what keeps the bootstrap operator's console access guaranteed.
    let userId: string;
    const existing = await User.findOne({ email: u.email }).lean().exec();
    if (existing) {
      userId = existing._id;
      usersSkipped++;
    } else {
      const created = await User.create({
        email: u.email, passwordHash: hashSecret(u.password),
        status: u.status, passwordUpdatedAt: now
      });
      userId = created._id;
      usersCreated++;
    }

    // Application assignments (ADR-0019/0020): entitlement + app-scoped roles. Upserted every run so the
    // seed is the safety net for the operator — admin@identity-service.fps4.nl always keeps its
    // identity-console/platform_admin assignment and thus console access.
    for (const a of u.assignments ?? []) {
      await Assignment.updateOne(
        { userId, applicationId: a.application },
        {
          $set: { roles: a.roles ?? [], status: 'active', updatedAt: now },
          $setOnInsert: { _id: randomUUID(), userId, applicationId: a.application, createdBy: 'seed', createdAt: now }
        },
        { upsert: true }
      ).exec();
      assignmentsUpserted++;
    }
  }

  console.log(`seed: ${appsUpserted} applications, ${clientsUpserted} credentials upserted; ${usersCreated} users created, ${usersSkipped} existing skipped; ${assignmentsUpserted} assignments upserted`);
}

main()
  .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
  .finally(() => disconnect());
