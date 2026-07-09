# Glossary

Terms where identity-service's business language and code diverge, or that a consumer must get right.

- **Deployment / realm** — one running instance of identity-service (`ds1`, …): its own MongoDB, active
  signing key, issuer origin, Google app, and a single shared user pool. The deployment *is* the tenancy
  boundary — there is **no** `Tenant` entity or `tenants` collection (removed in
  [ADR-0018](docs/design/decisions/0018-collapse-tenant-into-deployment.md)). Realm-wide config is
  deployment env (`CORS_ORIGINS`, `AUTH_REGISTRATION_MODE`, `AUTH_LOCAL_IDP_ENABLED`, `AUTH_ALLOWED_ROLES`,
  `CONFIG.oauth.limits`), not a per-row document.

- **Application** — the first-class per-consumer object (`applications` collection, ADR-0020): a **product**.
  It owns a `name`, a **default `audience`** (the token `aud` for tokens minted through its credentials), the
  **role catalogue** (`roles: [{ key, name?, description? }]`, ADR-0019), and the users **assigned** to it.
  Not a Tenant — it groups credentials + roles + members but does **not** own or partition users
  (the realm and user pool stay single and shared, ADR-0018). Azure-AD-style "app registration."

- **Credential** — an OAuth **client** *under* an application (`oauth_clients`, keyed by `applicationId` —
  ADR-0020): the auth material that authenticates *as* the application. A product is typically a
  **user-login (web) credential** (`password`/`authorization_code`) plus a **machine/runtime credential**
  (`client_credentials`), and sometimes CI credentials, all under one application. Carries `grantTypes`,
  `redirectUris`, `scopes`, `isConfidential`, `secretHash`, and an optional `audience` **override** (a
  product runtime aimed at `maestro-workspace` overrides its app's default). The role catalogue and default
  audience live on the **application**, not the credential. The `client_id` is the document `_id`.

- **Client** — the OAuth term for a **credential** (above). Since [ADR-0020](docs/design/decisions/0020-application-aggregate.md)
  a client is no longer the unit of everything: it belongs to an application (`applicationId`, required),
  carries **no** `roles`, and its `audience` is only an optional override. The admin/seed/MCP surfaces speak
  of "credentials under an application"; `oauth_clients` is the storage.

- **Assignment** — a user↔application entitlement (`assignments` collection, ADR-0019 / ADR-0020): one record
  per `{userId, applicationId}` pair, carrying the app-scoped `roles` granted to that user and a `status`
  (`active` | `suspended`). A user needs an **active** assignment to be issued a token for an application — a
  hard, **global** gate on every user grant (`password`, `authorization_code`, `refresh`); no assignment ⇒
  `access_denied` at `/oauth2/token`. The issuance gate resolves the credential → its application, then
  checks the assignment. The token's `roles` claim is sourced from `assignment.roles`. Created by operators
  (management plane) or by redeeming an invite. Machine (`client_credentials`) tokens have no user and are
  unaffected.

- **Application role / role catalogue** — the set of roles that exist *for one application*, declared on
  the **application** as `roles: [{ key, name?, description? }]` (ADR-0019; owned by the application since
  ADR-0020, not by any single credential). `key` is the stable token value; `name`/`description` are for
  the console. Seed-bootstrapped **and** runtime-editable via the management plane
  (`GET/PUT /applications/:id/roles`); the live DB is authoritative (ADR-0008). An assignment grants a
  user a subset of the target application's catalogue.

- **Client credentials** — the machine-to-machine grant. A confidential client exchanges its secret
  for a short-lived access token carrying `cid` / `sid` / `scope`.

- **User identity token** — the human-login token. An RS256 JWT carrying `email`, a stable `sub`,
  `iss`, an `aud` (the application's default audience, or the credential's override — ADR-0020), `exp`/`iat`,
  and an optional `roles` array — the user's **app-scoped** roles in that application, from the assignment
  (ADR-0019). Proves *who you are*, not *what you may do*. Issued by either IdP (Google SSO or local password)
  with the same shape, and only when the user holds an active assignment for the application.

- **Role** — an **app-scoped** string (e.g. `platform_admin`, `learner`) drawn from a specific
  application's role catalogue and granted to a user through an **assignment** to that app (ADR-0019). It
  is stamped into the user token's `roles` claim, sourced from `assignment.roles` — so a role means "this
  user's role *in the audience's application*," not a deployment-wide attribute (the flat `user.roles` is
  **removed**). Roles are provisioned per-app by operators (`POST /assignments`) or by invites, and the
  role vocabulary is the application's catalogue (`GET/PUT /applications/:id/roles`). identity-service **asserts**
  roles but does not enforce them — each product maps roles to its own permissions
  ([ADR-0005](docs/design/decisions/0005-decentralized-authorization.md)). Contrast **scope**
  (machine/client authorization); roles describe the *user, within one app*.

- **IdP (identity provider)** — how a user authenticates. `google` federates Google SSO (RQ-0001);
  `local` is identity-service's own email/password store (RQ-0002), toggled deployment-wide by
  `AUTH_LOCAL_IDP_ENABLED`. Both issue the same user token.

- **Local user** — an email/password account in the `users` collection (RQ-0002). Globally-unique
  email (one record per person for the whole deployment), salted-scrypt password hash, a stable
  server-minted `sub`, and brute-force lockout counters. The user record carries **no** `roles` field
  (ADR-0019) — an account exists deployment-wide, but reaching any application requires an active
  **assignment** to it.

- **Invite** — an operator-issued, show-once registration code (`invites` collection) gating
  self-registration when the deployment's `AUTH_REGISTRATION_MODE` is `invite` (RQ-0013). Now carries a
  target **`applicationId`** + **`roles`** from that application's catalogue (ADR-0019 / ADR-0020): redeeming
  it provisions the user (if new) **and** creates the assignment, landing the person directly into one
  application with the intended roles. Optionally email-bound, multi-use, expiring, revocable; only a SHA-256
  digest is stored. Distributed out-of-band by the operator — the service validates codes, it never sends them.

- **Audience (`aud`)** — the consumer/workspace a user token is bound to: the **application's** default
  `audience`, or a credential's `audience` **override** where set (ADR-0020). A consumer verifies `aud`
  equals its own configured value; a token for one workspace is invalid for another.

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

- **Management plane** — the authenticated, audited day-2 surface (ADR-0007): the HTTP `/admin/v1` API,
  an MCP server, and an operator console, all over one service layer. Manages **applications** (their role
  catalogues, members, and **credentials** — ADR-0020), users, **assignments** (user↔app entitlements —
  ADR-0019), invites, rotates secrets and signing keys, and serves statistics. Network-restricted — kept off
  the public token-issuance surface. Distinct from the runtime OAuth/session endpoints.

- **Admin scope** — the privilege a `client_credentials` token must carry to reach the management plane.
  The superscope `admin` satisfies every admin route; granular per-area scopes (`admin:clients`,
  `admin:users`, `admin:keys`, `admin:stats`) let an agent hold least capability. Admin
  tokens are this service's own client tokens, verified against its own JWKS — there is no separate admin
  issuer. Contrast **scope** (client runtime authorization) and **roles** (the user, per app).

- **Operator / platform_admin** — the human who drives the admin console. Under ADR-0019/0020 the operator is
  no longer a user carrying a deployment-wide role; instead **`identity-console` is itself an application**
  whose role catalogue holds **`platform_admin`** (with a user-login credential under it), and the operator
  holds an `identity-console` assignment granting that role (folding ADR-0010). The management plane still
  reads the token's `roles` claim and matches
  `ADMIN_OPERATOR_ROLES` (default `platform_admin`) — only the *source* of that claim moved from
  `user.roles` to the identity-console assignment. The bootstrap operator
  (`admin@identity-service.fps4.nl`) is always seeded with that assignment so the console is never lockable.

- **Audit log** — the append-only `audit_logs` collection recording every management mutation (who, what,
  when). The per-actor accountability ADR-0003 said a static admin secret could not provide.

- **MCP management server** — the Model Context Protocol face of the management plane (`npm run mcp`,
  stdio JSON-RPC). A thin adapter over the same service layer + admin-auth + audit as the HTTP API — one
  authorization model, two transports — so agents can drive onboarding and rotation as typed tools.

- **Admin console** — the operator-facing web app (`@fps4/identity-service-console`, Next.js) over
  `/admin/v1`. A thin server-side client holding no database credentials; the admin token never reaches
  the browser. Distinct from the consumer-facing `<Login/>` widget shipped in `react/`.
