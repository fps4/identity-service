/**
 * A role that exists *within* an application (ADR-0019, now app-level per ADR-0020). `key` is the stable
 * value stamped into the token `roles` claim for a user assigned this role; `name`/`description` are
 * console labels. The catalogue is the closed vocabulary an assignment's roles must be drawn from.
 */
export interface AppRole {
  key: string;
  name?: string;
  description?: string;
}

/**
 * An Application (ADR-0020) — a product. The first-class unit: it owns its name, its default token
 * `audience`, and its role catalogue, and it is the thing users are ASSIGNED to. OAuth clients are typed
 * CREDENTIALS *under* an application (`oauth_client.applicationId`) that authenticate as it. This is a
 * grouping over the shared user pool (ADR-0018) — NOT a Tenant: it does not own or partition users.
 *
 * Stored as `realm#application` / `<_id>` (ADR-0023).
 */
export interface ApplicationDocument {
  _id: string;
  name: string;
  // Default token `aud` for tokens minted through this application's credentials. A credential may carry
  // its own `audience` override (e.g. a product runtime aimed at maestro-workspace).
  audience?: string;
  roles: AppRole[]; // the application's role catalogue
  /**
   * The protected resources this application owns (ADR-0009 Phase 2) — canonical RFC 8707 resource
   * identifiers such as an MCP endpoint URL. A token request naming one of these binds the token's `aud`
   * to it instead of the application default; a resource NOT listed here (and not this service's own MCP
   * resource) is refused with `invalid_target`, so an application can never mint a token audienced at a
   * resource it does not own.
   */
  resources: string[];
  createdAt?: Date;
  updatedAt?: Date;
}
