/**
 * A person in the deployment's user pool (RQ-0002, RQ-0011, ADR-0018). Provider-agnostic: a user may
 * carry a local email/password credential (RQ-0002), one or more federated identities (RQ-0011 — e.g.
 * Google SSO, RQ-0001), or both. Whatever the provider, authentication issues the same RS256 user token
 * (`email` + stable `sub`) maestro verifies.
 *
 * `_id` is a stable, immutable id minted at creation (NOT the email). For a **local** login the token
 * `sub` is this `_id`; for a **federated** login the token `sub` is the *provider* subject (the Google
 * `sub`), preserved verbatim to satisfy the RQ-0001 fixed contract (ADR-0012). This record is therefore
 * a resolution layer *behind* the token — it never changes the emitted claims. `status`/lockout apply to
 * the person regardless of how they authenticated. Roles are NOT on the user: they are per-application
 * and live on the assignments (ADR-0019).
 *
 * `passwordHash` is OPTIONAL: a federated-only user has none (and cannot password-login). When present
 * it uses the salted scrypt scheme in `utils/hash.ts`; the raw password is never stored.
 *
 * Stored as `realm#user` / `<_id>`. The email and each linked `(provider, subject)` are unique through
 * `unique` items written in the same transaction, which are also how a login finds the person (ADR-0023).
 */
export interface FederatedIdentity {
  provider: 'google';       // the upstream IdP (only Google today; RQ-0001)
  subject: string;          // the provider's stable subject — becomes the token `sub` for this login
  email?: string;           // the email the provider asserted (informational; may differ from user.email)
  emailVerified: boolean;   // whether the provider vouched the email — the linking gate (RQ-0011 US-4)
  linkedAt: Date;
}

export interface UserDocument {
  _id: string;              // stable subject id (the token `sub` for local logins)
  email: string;            // unique within the deployment (stored lowercased)
  passwordHash?: string;    // optional — absent for federated-only users
  identities: FederatedIdentity[]; // linked upstream IdP identities (RQ-0011)
  emailVerified: boolean;   // whether the email is vouched (by a provider or, later, a verify channel)
  status: 'active' | 'locked' | 'disabled';
  failedAttempts: number;
  lockedUntil?: Date | null;
  passwordUpdatedAt?: Date;
  lastLoginAt?: Date | null;
  /**
   * The person's maestro principal id — `prn-h-…` (ADR-0022). Minted when the user is created and
   * backfilled on first use for records that predate it; surfaced in every token as the `prn` claim. This
   * is the id maestro's record names; the token `sub` (this `_id`, or a provider subject) never reaches it.
   */
  principalId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
