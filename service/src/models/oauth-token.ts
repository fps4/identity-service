/**
 * An issued token's metadata: an access token by its `jti`, or a refresh token by an internal id with
 * only the hash of its value. Stored as `realm#oauth_token` / `<_id>`; a refresh token is found by its
 * hash through `gsi1`, and the day's issuance is counted per type through `gsi2` (ADR-0023). The table's
 * TTL removes a token a day after it expired.
 */
export interface OAuthTokenDocument {
  _id: string; // access token id (jti) or refresh token id
  clientId: string;
  subject?: string;
  sessionId?: string;
  type: 'access' | 'refresh';
  scope: string[];
  expiresAt: Date;
  issuedAt: Date;
  refreshTokenId?: string;
  status: 'active' | 'revoked' | 'expired';
  hashedToken?: string; // for refresh tokens to avoid storing raw value
  /**
   * The RFC 8707 resource this token chain is bound to (ADR-0009 Phase 2), carried so a REFRESH can
   * re-mint the same `aud`. Without it the refresh silently falls back to the application's audience and
   * the resource server rejects the result — the login looks fine and the connection dies at the first
   * token expiry. Absent for tokens issued without a resource indicator.
   */
  resource?: string;
}
