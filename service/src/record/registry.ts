/**
 * The principal registry's operations (ADR-0022): mint a maestro principal id for a user or a
 * credential, backfill one for a record that predates the registry, and resolve ids to kinds for the
 * spine's append rules.
 *
 * Minting is idempotent and safe under a race: the registry row's binding is unique by what it binds
 * to, and the `principalId` on the user/credential is set only where it is still absent, so two requests
 * that both find an id missing converge on one. A record's principal id, once set, never changes.
 *
 * A backfill is its own transaction, committed before the act that needed it: DynamoDB refuses two
 * writes to one item in a transaction, and the act may well write the same user again (a deletion, a
 * status change). It mints only — it emits no event — so an act that fails after it leaves nothing
 * wrong behind: the id is the record's, backfilled on first use as ADR-0022 says.
 */
import type { PrincipalDocument, PrincipalKind, PrincipalStatus } from '../models/index.js';
import { ConditionFailed, Transaction, type Store } from '../db/index.js';
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

/** The registry row for a new principal — what an act registers in its own transaction. */
export function principalRow(id: string, kind: PrincipalKind, status: PrincipalStatus, subjectType: 'user' | 'client', subjectId: string, now: Date): PrincipalDocument {
  return { _id: id, kind, status, subjectType, subjectId, createdAt: now, updatedAt: now };
}

/**
 * The user's principal, minted and persisted if the record has none yet (the lazy migration for a pool
 * that predates ADR-0022). The backfill mints only — it emits no `PrincipalRegistered`, because the
 * registration it would describe happened before there was a record to hold it; the M2 enumeration
 * endpoint is how a consumer reconciles principals the archive never saw born.
 */
export async function ensureUserPrincipal(
  store: Store,
  user: { _id: string; principalId?: string; status?: string }
): Promise<KnownPrincipal> {
  if (user.principalId) return { id: user.principalId, kind: 'human' };
  const id = await bind(store, 'user', user._id, 'human', principalStatusOf(user));
  await store.users.setPrincipalIdIfAbsent(user._id, id);
  // Under a race the other writer's id is the one on the record; the registry row agrees by its binding.
  const fresh = await store.users.get(user._id);
  return { id: fresh?.principalId ?? id, kind: 'human' };
}

/**
 * The credential's principal, minted and persisted if it has none — or `null` for a credential that is
 * not a principal (a user-login credential). Same backfill rule as for users.
 */
export async function ensureClientPrincipal(
  store: Store,
  client: { _id: string; principalId?: string; grantTypes?: string[]; claims?: Record<string, unknown> }
): Promise<KnownPrincipal | null> {
  const kind = clientPrincipalKind(client);
  if (!kind) return null;
  if (client.principalId) return { id: client.principalId, kind };
  const id = await bind(store, 'client', client._id, kind, 'active');
  await store.clients.setPrincipalIdIfAbsent(client._id, id);
  const fresh = await store.clients.get(client._id);
  return { id: fresh?.principalId ?? id, kind };
}

/** Register the row for a subject, or return the one a concurrent writer already registered. */
async function bind(
  store: Store,
  subjectType: 'user' | 'client',
  subjectId: string,
  kind: PrincipalKind,
  status: PrincipalStatus
): Promise<string> {
  const existing = await store.principals.getBySubject(subjectType, subjectId);
  if (existing) return existing._id;
  const id = mintPrincipalId(kind);
  const tx = new Transaction();
  store.principals.register(tx, principalRow(id, kind, status, subjectType, subjectId, new Date()));
  try {
    await store.commit(tx);
    return id;
  } catch (err) {
    if (err instanceof ConditionFailed) {
      const raced = await store.principals.getBySubject(subjectType, subjectId);
      if (raced) return raced._id;
    }
    throw err;
  }
}

/** Mirror a subject's status change onto its registry row, inside the act's transaction. The row is never deleted. */
export function setPrincipalStatus(store: Store, tx: Transaction, principalId: string, status: PrincipalStatus, now = new Date()): void {
  store.principals.setStatus(tx, principalId, status, now);
}

/**
 * The kinds of a set of principal ids, from the registry — and from the transaction in hand, for a
 * principal registered in the same act as the event that names it. What the spine's `assertEvent`
 * resolver reads: an id the registry does not know is unresolvable and the event naming it is refused.
 */
export async function loadKinds(store: Store, ids: Iterable<string>, tx?: Transaction): Promise<Map<string, { kind: PrincipalKind }>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const out = new Map<string, { kind: PrincipalKind }>();
  if (unique.length === 0) return out;
  for (const row of await store.principals.getMany(unique)) out.set(row._id, { kind: row.kind });
  if (tx) for (const row of store.principals.stagedIn(tx)) if (unique.includes(row._id)) out.set(row._id, { kind: row.kind });
  return out;
}
