/**
 * The principal registry (ADR-0022): maestro's view of everyone this deployment can authenticate.
 *
 * A **principal** is anyone or anything that acts and is recorded — a **human** (a user in the pool),
 * an **agent** (a client-credentials credential an AI runtime authenticates with) or a **workload** (a
 * client-credentials credential a deployed service authenticates with). Its `_id` is the maestro
 * principal id — `prn-h-…` / `prn-a-…` / `prn-w-…`, the kind letter then lower-case Crockford base32 —
 * and it is the ONLY identifier of a person or a machine that ever reaches maestro's record. A token
 * `sub`, an email, a client id: none of them leaves this service.
 *
 * The row outlives what it points at. Deleting a user or a credential RETIRES its principal here rather
 * than removing it, because events already in maestro's archive name the id, and a relay that could no
 * longer resolve it would refuse them — the archive must be able to say what kind of thing acted, for
 * as long as it holds the event. `status` mirrors the subject's: active, suspended (disabled), retired
 * (deleted). Nothing reads it for authorisation; the user's/credential's own record still gates that.
 *
 * Stored as `ws#<workspace_id>#principal` / `<_id>`; the binding `(subjectType, subjectId)` is unique
 * through a `unique` item written in the same transaction, which is also how a subject finds its
 * principal (ADR-0023).
 */
export type PrincipalKind = 'human' | 'agent' | 'workload';
export type PrincipalStatus = 'active' | 'suspended' | 'retired';

export interface PrincipalDocument {
  _id: string;                       // the maestro principal id: prn-h-… | prn-a-… | prn-w-…
  kind: PrincipalKind;
  status: PrincipalStatus;
  subjectType: 'user' | 'client';    // which kind of item the principal is bound to
  subjectId: string;                 // User._id or OAuthClient._id — a binding, never copied onto an event
  createdAt?: Date;
  updatedAt?: Date;
}
