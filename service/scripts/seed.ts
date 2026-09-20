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
 * safe: applications and credential STRUCTURE are upserted; existing users are left untouched
 * (insert-if-absent), so a re-run never resets a password — use `manage-users set-password` to change
 * one. Credential SECRETS follow the same insert-if-absent rule (ADR-0021, {@link credentialUpdate}):
 * a re-seed never overwrites one, so it cannot revert a rotation.
 *
 * The seed is an OPERATOR'S act on maestro's record (ADR-0022). Every principal it creates and every
 * seat it grants or revokes is emitted to the spine, attributed to the person running it:
 *
 *   npm run seed -- --as=<email>       # the operator; default: the FIRST user in the seed file
 *
 * That person is registered first (by themselves, `source: seed`) if the file introduces them, so the
 * bootstrap operator's own registration is the first event of a fresh realm. A re-run emits only what
 * changed — a new credential, a role that changed hands — never the whole file again.
 */
import process from 'process';
import { randomUUID, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { uuidv7 } from '@fps4/maestro-spine';
import { getMasterConnection, disconnect } from '../src/utils/db.js';
import { makeModels } from '../src/models/index.js';
import { hashSecret } from '../src/utils/hash.js';
import { CONFIG } from '../src/config.js';
import type { Connection } from 'mongoose';
import type { ModelsBucket } from '../src/oauth/types.js';
import { parseSeedConfig, type SeedConfig, type SeedCredential } from '../src/services/seed-config.js';
import { assertPasswordPolicy, normalizeEmail } from '../src/services/users.js';
import {
  clientPrincipalKind,
  createRecorder,
  ensureClientPrincipal,
  ensureUserPrincipal,
  mintPrincipalId,
  operatorContext,
  realmOf,
  selfContext,
  withRecordTransaction,
  type Act,
  type RecordConfig
} from '../src/record/index.js';

/**
 * The Mongo update for one seeded credential, split into what a re-seed may reconcile and what it may
 * only ever write once (ADR-0021).
 *
 * Structure — grants, redirect URIs, audience, claims — is declarative, so it goes in `$set` and is
 * reconciled on every run. The secret hash is NOT. A confidential credential's secret is minted by
 * identity-service and handed to its consumer once, so re-hashing a config value on every run would
 * silently revert an operational rotation: the credential keeps working here and stops working for
 * whoever holds the rotated value. It goes in `$setOnInsert`, which Mongo applies only when the upsert
 * actually inserts — the same insert-if-absent rule users have always had.
 *
 * A confidential credential declared with no `secret:` is inserted with an unguessable random hash that
 * nobody holds. That is deliberate, not a gap: the credential exists structurally and cannot
 * authenticate until an operator calls `rotate_client_secret` and stores the returned value with the
 * consumer. Structure arrives by PR; the secret never enters git or this repo's CI.
 */
export function credentialUpdate(c: SeedCredential, applicationId: string, now: Date): {
  $set: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
} {
  const $set: Record<string, unknown> = {
    applicationId, name: c.name, grantTypes: c.grantTypes,
    redirectUris: c.redirectUris, scopes: c.scopes, audience: c.audience,
    isConfidential: c.isConfidential, updatedAt: now
  };
  // A client-credentials machine principal (US-0086): the runtime subject + additive claims.
  if (c.subject !== undefined) $set.subject = c.subject;
  if (c.claims !== undefined) $set.claims = c.claims;

  if (c.secret) return { $set, $setOnInsert: { secretHash: hashSecret(c.secret) } };
  if (c.isConfidential) return { $set, $setOnInsert: { secretHash: hashSecret(randomBytes(32).toString('base64url')) } };
  return { $set };   // a public client authenticates with no secret at all (PKCE / password grant)
}

function resolveFile(): string {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--file='));
  if (arg) return arg.slice('--file='.length);
  if (process.env.SEED_FILE) return process.env.SEED_FILE;
  return new URL('../../config/seed.yaml', import.meta.url).pathname; // repo-root/config/seed.yaml
}

/** The operator the seed's acts are attributed to: `--as=<email>`, `SEED_AS`, else the file's first user. */
export function resolveOperatorEmail(argv: string[], env: NodeJS.ProcessEnv, firstUser?: string): string | undefined {
  const arg = argv.find((a) => a.startsWith('--as='));
  const raw = arg ? arg.slice('--as='.length) : env.SEED_AS || firstUser;
  return raw ? normalizeEmail(raw) : undefined;
}

/** The roles a machine credential declares — its seats on maestro's record (ADR-0022). */
export function declaredRoles(claims?: Record<string, unknown>): string[] {
  const roles = claims?.roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === 'string' && r.length > 0);
  if (typeof roles === 'string') return roles.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** One `SeatOccupancyChanged` per role that changed hands. */
export function seatChanges(principal: string, application: string, before: readonly string[], after: readonly string[], oversight_level: 'O0' | 'O1'): Act[] {
  const was = new Set(before);
  const is = new Set(after);
  const acts: Act[] = [];
  for (const seat of after) if (!was.has(seat)) acts.push({ type: 'SeatOccupancyChanged', subject: principal, body: { seat, application, change: 'granted', oversight_level } });
  for (const seat of before) if (!is.has(seat)) acts.push({ type: 'SeatOccupancyChanged', subject: principal, body: { seat, application, change: 'revoked', oversight_level } });
  return acts;
}

export interface SeedRunDeps {
  config: SeedConfig;
  connection: Connection;
  models: ModelsBucket;
  operatorEmail: string;
  record: RecordConfig;
  now?: Date;
}

export interface SeedRunReport {
  appsUpserted: number;
  clientsUpserted: number;
  usersCreated: number;
  usersSkipped: number;
  assignmentsUpserted: number;
  eventsEmitted: number;
  operatorPrincipalId: string;
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

  const operatorEmail = resolveOperatorEmail(process.argv.slice(2), process.env, config.users[0]?.email);
  if (!operatorEmail) throw new Error('The seed needs an operator to attribute its acts to: pass --as=<email> or list a user in the seed file');

  const connection = await getMasterConnection();
  const r = await runSeed({
    config,
    connection,
    models: makeModels(connection),
    operatorEmail,
    record: { workspaceId: CONFIG.record.workspaceId, accountable: CONFIG.record.accountable, consequenceClass: CONFIG.record.consequenceClass }
  });
  console.log(`seed: ${r.appsUpserted} applications, ${r.clientsUpserted} credentials upserted; ${r.usersCreated} users created, ${r.usersSkipped} existing skipped; ${r.assignmentsUpserted} assignments upserted; ${r.eventsEmitted} events recorded as ${operatorEmail} (${r.operatorPrincipalId})`);
}

/** The seed run itself, over an open connection — what `main` calls and a test drives against a fake. */
export async function runSeed({ config, connection, models, operatorEmail, record, now = new Date() }: SeedRunDeps): Promise<SeedRunReport> {
  const { Application, OAuthClient, User, Assignment, Principal } = models;
  const realm = realmOf(record.workspaceId);
  const correlation_id = uuidv7(); // one per run: every event the seed records carries it
  let appsUpserted = 0, clientsUpserted = 0, usersCreated = 0, usersSkipped = 0, assignmentsUpserted = 0, eventsEmitted = 0;

  for (const app of config.applications) {
    // The application owns its name, default audience, role catalogue, and protected-resource registry
    // (ADR-0020, ADR-0009 Phase 2). Like `roles`, `resources` is REPLACED wholesale on every run — a seed
    // file naming an application must restate both in full or it silently empties them.
    await Application.updateOne(
      { _id: app.id },
      { $set: { name: app.name, audience: app.audience, roles: app.roles ?? [], resources: app.resources ?? [], updatedAt: now } },
      { upsert: true }
    ).exec();
    appsUpserted++;
  }

  // The operator first (ADR-0022): the person every other act of this run is attributed to. If the file
  // introduces them, their own registration — by themselves, in the `self` seat — is the run's first
  // event; otherwise they must already exist in the pool.
  const seededOperator = config.users.find((u) => normalizeEmail(u.email) === operatorEmail);
  let operator: { _id: string; principalId?: string; status?: string } | null =
    await User.findOne({ email: operatorEmail }).select('_id principalId status').lean().exec();
  let operatorCreatedHere = false;
  if (!operator && seededOperator) {
    const principalId = mintPrincipalId('human');
    operator = await withRecordTransaction(connection, async (session) => {
      const [created] = await User.create([{
        email: operatorEmail, passwordHash: hashSecret(seededOperator.password),
        status: seededOperator.status, passwordUpdatedAt: now, principalId
      }], { session });
      await Principal.create([{ _id: principalId, kind: 'human', status: seededOperator.status === 'disabled' ? 'suspended' : 'active', subjectType: 'user', subjectId: created._id, createdAt: now, updatedAt: now }], { session });
      const self = createRecorder({ models, config: record, ...selfContext({ id: principalId, kind: 'human' }, correlation_id) });
      eventsEmitted += (await self.emit(session, [{ type: 'PrincipalRegistered', subject: principalId, body: { kind: 'human', source: 'seed', realm } }])).length;
      return { _id: created._id, principalId, status: seededOperator.status };
    });
    usersCreated++;
    operatorCreatedHere = true;
  }
  if (!operator) throw new Error(`The operator ${operatorEmail} is neither in the pool nor in the seed file; pass --as=<email> naming an existing user`);
  const operatorPrincipal = await ensureUserPrincipal(models, operator);
  const ctx = operatorContext(operatorPrincipal, correlation_id);
  const recorder = createRecorder({ models, config: record, ...ctx });

  for (const app of config.applications) {
    // Each credential (OAuth client) under the application. Structure is reconciled every run; the
    // secret hash is written once on insert and never again — see credentialUpdate. A machine credential
    // is a principal (ADR-0022): registered when inserted, its declared roles seats that follow the diff.
    for (const c of app.credentials ?? []) {
      const before = await OAuthClient.findById(c.id).lean().exec();
      const kind = clientPrincipalKind({ grantTypes: c.grantTypes, claims: c.claims });
      await withRecordTransaction(connection, async (session) => {
        const update = credentialUpdate(c, app.id, now);
        const principalId = !before && kind ? mintPrincipalId(kind) : undefined;
        if (principalId) update.$setOnInsert = { ...(update.$setOnInsert ?? {}), principalId };
        await OAuthClient.updateOne({ _id: c.id }, update, { upsert: true, session }).exec();
        const acts: Act[] = [];
        if (principalId && kind) {
          await Principal.create([{ _id: principalId, kind, status: 'active', subjectType: 'client', subjectId: c.id, createdAt: now, updatedAt: now }], { session });
          acts.push({ type: 'PrincipalRegistered', subject: principalId, body: { kind, source: 'seed', realm } });
          acts.push(...seatChanges(principalId, app.id, [], declaredRoles(c.claims), 'O1'));
        } else if (kind) {
          const principal = await ensureClientPrincipal(models, { ...(before as { _id: string; principalId?: string }), grantTypes: c.grantTypes, claims: c.claims }, session);
          if (principal) acts.push(...seatChanges(principal.id, app.id, declaredRoles((before as { claims?: Record<string, unknown> } | null)?.claims), declaredRoles(c.claims), 'O1'));
        }
        eventsEmitted += (await recorder.emit(session, acts)).length;
      });
      clientsUpserted++;
    }
  }

  for (const u of config.users) {
    const email = normalizeEmail(u.email);
    // Never clobber an existing account's credentials on re-run, but always reconcile its assignments
    // below (idempotent) — this is what keeps the bootstrap operator's console access guaranteed.
    let userId: string;
    const existing = await User.findOne({ email }).lean().exec();
    if (existing) {
      userId = existing._id;
      await ensureUserPrincipal(models, existing);
      if (!(email === operatorEmail && operatorCreatedHere)) usersSkipped++;
    } else {
      const principalId = mintPrincipalId('human');
      userId = await withRecordTransaction(connection, async (session) => {
        const [created] = await User.create([{
          email, passwordHash: hashSecret(u.password),
          status: u.status, passwordUpdatedAt: now, principalId
        }], { session });
        await Principal.create([{ _id: principalId, kind: 'human', status: u.status === 'disabled' ? 'suspended' : 'active', subjectType: 'user', subjectId: created._id, createdAt: now, updatedAt: now }], { session });
        eventsEmitted += (await recorder.emit(session, [{ type: 'PrincipalRegistered', subject: principalId, body: { kind: 'human', source: 'seed', realm } }])).length;
        return created._id;
      });
      usersCreated++;
    }
    const principal = await ensureUserPrincipal(models, { _id: userId, principalId: (await User.findById(userId).select('principalId').lean().exec())?.principalId });

    // Application assignments (ADR-0019/0020): entitlement + app-scoped roles. Upserted every run so the
    // seed is the safety net for the operator — the bootstrap operator always keeps its console
    // assignment and thus console access. Each role that changes hands is a seat on the record.
    for (const a of u.assignments ?? []) {
      await withRecordTransaction(connection, async (session) => {
        const before = await Assignment.findOne({ userId, applicationId: a.application }, null, { session }).lean().exec();
        await Assignment.updateOne(
          { userId, applicationId: a.application },
          {
            $set: { roles: a.roles ?? [], status: 'active', updatedAt: now },
            $setOnInsert: { _id: randomUUID(), userId, applicationId: a.application, createdBy: 'seed', createdAt: now }
          },
          { upsert: true, session }
        ).exec();
        const wasActive = before && before.status !== 'suspended' ? (before.roles ?? []) : [];
        eventsEmitted += (await recorder.emit(session, seatChanges(principal.id, a.application, wasActive, a.roles ?? [], 'O0'))).length;
      });
      assignmentsUpserted++;
    }
  }

  return { appsUpserted, clientsUpserted, usersCreated, usersSkipped, assignmentsUpserted, eventsEmitted, operatorPrincipalId: operatorPrincipal.id };
}

// Only hit the database when run as a script — importing the pure helpers (tests) must not connect.
// Same guard as scripts/dump-seed.ts.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
    .finally(() => disconnect());
}
