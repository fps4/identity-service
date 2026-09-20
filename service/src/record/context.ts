/**
 * Who is acting on this request (ADR-0022 §4): the act context a route or an MCP tool call resolves once
 * at the edge and hands to the service layer with every mutating operation.
 *
 * A management-plane caller is either an OPERATOR — a person with a user token whose `roles` carry an
 * operator role (ADR-0010) — or a MACHINE — a client-credentials token (ADR-0007). Both are resolved to
 * the maestro principal behind the token: from its `prn` claim when it carries one (every token minted
 * since ADR-0022 does), else by looking the subject or client up and backfilling its id. A self-service
 * caller — someone registering, someone signing in with Google for the first time — is the principal
 * being registered, and acts in the `self` seat.
 */
import { uuidv7 } from '@fps4/maestro-spine';
import type { AdminPrincipal } from '../core/admin-auth.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { PrincipalKind } from '../models/principal.js';
import { ensureClientPrincipal, ensureUserPrincipal } from './registry.js';
import { ActRefused, type Actor } from './outbox.js';

export interface ActContext {
  actor: Actor;
  /** One per request; every event the request records carries it. */
  correlation_id: string;
}

/** The context of a principal acting for itself. */
export function selfContext(principal: { id: string; kind: PrincipalKind }, correlation_id = uuidv7()): ActContext {
  return { actor: { principal: principal.id, kind: principal.kind, seat: 'self' }, correlation_id };
}

/** The context of a known operator — what the seed script builds for the person running it. */
export function operatorContext(principal: { id: string; kind: PrincipalKind }, correlation_id = uuidv7()): ActContext {
  return { actor: { principal: principal.id, kind: principal.kind, seat: 'operator' }, correlation_id };
}

/**
 * Resolve a verified management-plane principal to the actor its acts are attributed to. Refuses a
 * token whose subject the registry cannot find: an operator that no longer exists, a credential that was
 * deleted since the token was minted. The refusal is `403`, like any other act it may not perform.
 */
export async function actContextFor(models: ModelsBucket, admin: AdminPrincipal, correlation_id = uuidv7()): Promise<ActContext> {
  if (admin.prn) {
    const known = await models.Principal.findById(admin.prn).select('_id kind status').lean().exec() as { _id: string; kind: PrincipalKind; status: string } | null;
    if (known && known.status !== 'retired') {
      return { actor: { principal: known._id, kind: known.kind, seat: 'operator' }, correlation_id };
    }
  }
  if (admin.kind === 'machine' && admin.clientId) {
    const client = await models.OAuthClient.findById(admin.clientId).lean().exec() as { _id: string; principalId?: string; grantTypes?: string[]; claims?: Record<string, unknown> } | null;
    const principal = client ? await ensureClientPrincipal(models, client) : null;
    if (!principal) throw new ActRefused('The credential behind this token is not a registered principal; it cannot act on the management plane.');
    return { actor: { principal: principal.id, kind: principal.kind, seat: 'operator' }, correlation_id };
  }
  if (admin.subject) {
    // A local login's `sub` is the user id; a federated login's is the provider subject (ADR-0012).
    const user = await models.User.findOne({ $or: [{ _id: admin.subject }, { 'identities.subject': admin.subject }] }).lean().exec() as { _id: string; principalId?: string; status?: string } | null;
    if (user) {
      const principal = await ensureUserPrincipal(models, user);
      return { actor: { principal: principal.id, kind: principal.kind, seat: 'operator' }, correlation_id };
    }
  }
  throw new ActRefused('The principal behind this token is not in the registry; it cannot act on the management plane.');
}
