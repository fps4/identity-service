/**
 * The principal registry's operations (ADR-0022): mint a maestro principal id for a user or a
 * credential, backfill one for a record that predates the registry, and resolve ids to kinds for the
 * spine's append rules.
 *
 * Minting is idempotent and safe under a race: the `principals` row is keyed by what it binds to, and
 * the `principalId` on the user/credential is set only where it is still absent, so two requests that
 * both find an id missing converge on one. A record's principal id, once set, never changes.
 */
import type { ClientSession } from 'mongoose';
import type { ModelsBucket } from '../oauth/types.js';
import type { PrincipalKind, PrincipalStatus } from '../models/principal.js';
import { mintPrincipalId } from './ids.js';

export interface KnownPrincipal {
  id: string;
  kind: PrincipalKind;
}

/**
 * The kind a credential registers as (ADR-0022 §2): a `client_credentials` credential is a machine
 * principal — an AGENT when it declares `claims.principal_kind: agent` (what an AI runtime's
 * credential carries; maestro-specs reads the same claim), otherwise a WORKLOAD. A credential without
 * that grant authenticates PEOPLE (password / authorization-code login) and is not a principal at all.
 */
export function clientPrincipalKind(client: { grantTypes?: string[]; claims?: Record<string, unknown> }): PrincipalKind | null {
  if (!client.grantTypes?.includes('client_credentials')) return null;
  return client.claims?.principal_kind === 'agent' ? 'agent' : 'workload';
}

/** The registry status a user's own status maps to. */
export function principalStatusOf(user: { status?: string }): PrincipalStatus {
  return user.status === 'disabled' ? 'suspended' : 'active';
}

/**
 * The user's principal, minted and persisted if the record has none yet (the lazy migration for a pool
 * that predates ADR-0022). The backfill mints only — it emits no `PrincipalRegistered`, because the
 * registration it would describe happened before there was a record to hold it; the M2 enumeration
 * endpoint is how a consumer reconciles principals the archive never saw born.
 */
export async function ensureUserPrincipal(
  models: ModelsBucket,
  user: { _id: string; principalId?: string; status?: string },
  session?: ClientSession
): Promise<KnownPrincipal> {
  if (user.principalId) return { id: user.principalId, kind: 'human' };
  const id = await bind(models, 'user', user._id, 'human', principalStatusOf(user), session);
  await models.User.updateOne(
    { _id: user._id, principalId: { $exists: false } },
    { $set: { principalId: id } },
    { session }
  ).exec();
  // Under a race the other writer's id is the one on the record; the registry row agrees by its key.
  const fresh = await models.User.findById(user._id, null, { session }).select('principalId').lean().exec() as { principalId?: string } | null;
  return { id: fresh?.principalId ?? id, kind: 'human' };
}

/**
 * The credential's principal, minted and persisted if it has none — or `null` for a credential that is
 * not a principal (a user-login credential). Same backfill rule as for users.
 */
export async function ensureClientPrincipal(
  models: ModelsBucket,
  client: { _id: string; principalId?: string; grantTypes?: string[]; claims?: Record<string, unknown> },
  session?: ClientSession
): Promise<KnownPrincipal | null> {
  const kind = clientPrincipalKind(client);
  if (!kind) return null;
  if (client.principalId) return { id: client.principalId, kind };
  const id = await bind(models, 'client', client._id, kind, 'active', session);
  await models.OAuthClient.updateOne(
    { _id: client._id, principalId: { $exists: false } },
    { $set: { principalId: id } },
    { session }
  ).exec();
  const fresh = await models.OAuthClient.findById(client._id, null, { session }).select('principalId').lean().exec() as { principalId?: string } | null;
  return { id: fresh?.principalId ?? id, kind };
}

/** Insert the registry row for a subject, or return the one a concurrent writer already inserted. */
async function bind(
  models: ModelsBucket,
  subjectType: 'user' | 'client',
  subjectId: string,
  kind: PrincipalKind,
  status: PrincipalStatus,
  session?: ClientSession
): Promise<string> {
  const existing = await models.Principal.findOne({ subjectType, subjectId }, null, { session }).lean().exec() as { _id: string } | null;
  if (existing) return existing._id;
  const id = mintPrincipalId(kind);
  const now = new Date();
  try {
    await models.Principal.create([{ _id: id, kind, status, subjectType, subjectId, createdAt: now, updatedAt: now }], { session });
    return id;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const raced = await models.Principal.findOne({ subjectType, subjectId }, null, { session }).lean().exec() as { _id: string } | null;
      if (raced) return raced._id;
    }
    throw err;
  }
}

/** Mirror a subject's status change onto its registry row. The row is never deleted (see the model). */
export async function setPrincipalStatus(
  models: ModelsBucket,
  principalId: string,
  status: PrincipalStatus,
  session?: ClientSession
): Promise<void> {
  await models.Principal.updateOne({ _id: principalId }, { $set: { status, updatedAt: new Date() } }, { session }).exec();
}

/**
 * The kinds of a set of principal ids, from the registry. What the spine's `assertEvent` resolver reads:
 * an id the registry does not know is unresolvable and the event naming it is refused.
 */
export async function loadKinds(
  models: ModelsBucket,
  ids: Iterable<string>,
  session?: ClientSession
): Promise<Map<string, { kind: PrincipalKind }>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, { kind: PrincipalKind }>();
  if (unique.length === 0) return out;
  const rows = await models.Principal.find({ _id: { $in: unique } }, null, { session }).select('_id kind').lean().exec() as Array<{ _id: string; kind: PrincipalKind }>;
  for (const row of rows) out.set(row._id, { kind: row.kind });
  return out;
}
