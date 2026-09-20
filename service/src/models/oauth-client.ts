/**
 * An OAuth client — a CREDENTIAL under an application (ADR-0020). A product's web frontend, backend
 * runtime, and CI principals are all credentials under one `applicationId`; the application owns the role
 * catalogue and the default audience. A credential of grant type `password`/`authorization_code` is a
 * user-login credential; `client_credentials` is a machine/runtime credential.
 *
 * Stored as `realm#oauth_client` / `<_id>`; listed per application through `gsi1` (ADR-0023).
 */
export interface OAuthClientDocument {
  _id: string; // client_id
  applicationId: string; // the Application this credential belongs to (ADR-0020)
  name: string;
  secretHash: string;
  grantTypes: string[];
  redirectUris: string[];
  scopes: string[];
  isConfidential: boolean;
  // An OPTIONAL per-credential `aud` OVERRIDE (ADR-0020). Normally the token `aud` is inherited from the
  // application's `audience`; a credential sets this only when it must differ — e.g. a product runtime
  // whose token is aimed at `maestro-workspace` rather than its own application's audience.
  audience?: string;
  // The `sub` a client-credentials token carries (US-0086). For a product_runtime credential this is the
  // deployment's runtime principal that the resource server (maestro) resolves against its register.
  // Falls back to the client id when unset.
  subject?: string;
  // Extra, additive claims merged into a client-credentials token (US-0086) — e.g.
  // `{ role: 'product_runtime', email: 'runtime@…' }` so the resource server can match its principal.
  // Registered claims (`iss`/`aud`/`exp`/`sub`/…) are always set by the signer and cannot be overridden.
  claims?: Record<string, unknown>;
  /**
   * The credential's maestro principal id (ADR-0022), set only for a `client_credentials` credential —
   * the thing that authenticates AS itself: `prn-a-…` when `claims.principal_kind` is `agent`, else
   * `prn-w-…` (a workload). A user-login credential (`password` / `authorization_code`) authenticates
   * people and is not a principal. Minted at creation, backfilled on first use; the `prn` token claim.
   */
  principalId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}
