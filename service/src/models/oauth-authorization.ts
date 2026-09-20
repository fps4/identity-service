/**
 * A single in-flight user login (RQ-0001). Created when the consumer's browser hits
 * `/oauth2/authorize`, carried through whichever IdP authenticates the person, and consumed once at
 * the `authorization_code` token exchange.
 *
 * Lifecycle: `pending` (awaiting the IdP) -> `authenticated` (identity established, our code minted)
 * -> `consumed` (token issued; the code is single-use). The table's TTL sweeps abandoned records.
 *
 * `codeChallenge` is the consumer's PKCE challenge (S256), verified against its `code_verifier`
 * at exchange. `googleState` / `nonce` protect the Google leg against CSRF / replay.
 *
 * `idp` records WHICH provider authenticated this login, because the two legs establish identity
 * differently and the exchange must not confuse them: `google` carries a federated subject that gets
 * JIT-provisioned or linked (RQ-0011), while `local` (RQ-0002) has already authenticated a real user
 * record and its `sub` IS that user's `_id`.
 *
 * Stored as `realm#oauth_authorization` / `<_id>`. Its three handles — `googleState`, `loginToken`,
 * `code` — are each resolved through a `unique` item written in the same transaction as the handle, so
 * the exchange that follows a redirect within the second reads its own write (ADR-0023).
 */
export interface OAuthAuthorizationDocument {
  _id: string;                 // internal authorization id
  clientId: string;
  consumerRedirectUri: string; // where we 302 back to the consumer (must be registered on the client)
  consumerState?: string;      // the consumer's opaque state, echoed back untouched
  codeChallenge: string;       // PKCE S256 challenge from the consumer
  codeChallengeMethod: 'S256';
  scope: string[];
  idp: 'google' | 'local';     // which provider authenticates this login
  resource?: string;           // RFC 8707 resource indicator; binds the issued token's `aud`
  loginToken?: string;         // single-use handle tying the local login form back to this record
  googleState: string;         // random state for the Google leg (matched on callback)
  nonce: string;               // random nonce embedded in + verified from Google's id_token
  status: 'pending' | 'authenticated' | 'consumed';
  code?: string;               // our single-use authorization code (minted once the IdP succeeds)
  email?: string;              // captured identity once the IdP verifies
  sub?: string;                // federated subject (google), or the local user's `_id`
  emailVerified?: boolean;     // whether the provider vouched the email — gates account linking (RQ-0011)
  expiresAt: Date;
  createdAt?: Date;
}
