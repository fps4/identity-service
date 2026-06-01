# Glossary

Terms where component-auth's business language and code diverge, or that a consumer must get right.

- **Tenant** — a product/organization registered in the `tenants` collection. Opts into OAuth via an
  `oauth` block (`enabled`, `allowedGrantTypes`, `allowedScopes`, `limits`, `idp`). Authentication is
  refused when a tenant is missing, not `active`, or has not enabled OAuth.

- **Client** — a registered consumer of a tenant (`oauth_clients`). Carries `grantTypes`,
  `redirectUris`, `scopes`, `isConfidential`, and — for user login — an `audience`. The `client_id`
  is the document `_id`.

- **Client credentials** — the machine-to-machine grant. A confidential client exchanges its secret
  for a short-lived access token carrying `tid` / `cid` / `sid` / `scope`.

- **User identity token** — the human-login token (RQ-0001). An RS256 JWT carrying `email`, the
  stable Google `sub`, `iss`, a consumer-bound `aud`, and `exp`/`iat`. Proves *who you are*, not
  *what you may do*.

- **Audience (`aud`)** — the consumer/workspace a user token is bound to (the client's `audience`
  field). A consumer verifies `aud` equals its own configured value; a token for one workspace is
  invalid for another.

- **Issuer (`iss`)** — the HTTPS base URL of this service (`AUTH_JWT_ISSUER`). A consumer enforces it.

- **PKCE** — Proof Key for Code Exchange (RFC 7636, S256 only). The public-client login proof: the
  browser holds a `code_verifier`; only its `code_challenge` is sent at `/oauth2/authorize`, and the
  verifier is presented at the token exchange. Replaces a client secret for the user flow.

- **Authorization record** — a short-lived `oauth_authorizations` document tying one login attempt
  together: the consumer's PKCE challenge + state, the Google `state`/`nonce`, and (after Google
  succeeds) the single-use code and captured identity. TTL-swept.

- **Nonce** — a random value embedded in the Google authorize request and verified back from
  Google's `id_token`, guarding the Google leg against replay.

- **Session** — a `sessions` document bounding a user token's absolute lifetime. Refresh tokens
  never outlive their session; revoking the session (`status: revoked`) kills refresh.

- **Refresh token** — an opaque, high-entropy, single-use (rotating) token. Only its SHA-256 hash is
  stored; presenting it mints a fresh access + refresh pair while its session is active.

- **JWKS** — the JSON Web Key Set at `/.well-known/jwks.json`: the RS256 public keys (by `kid`)
  consumers use to verify tokens. Publishes both `active` and `inactive` keys for rotation.

- **`kid`** — key id in a JWT header; selects which JWKS key verifies the signature.

- **Key rotation** — minting a new active signing key and demoting the previous one to `inactive`
  (still published, so its tokens verify until retired).
