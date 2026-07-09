---
title: "0018: Collapse Tenant into Deployment — one instance is one realm / one user pool"
summary: "Remove Tenant as a modelled partition. A deployment (e.g. ds1) is itself the tenancy boundary: one instance = one realm = one shared user pool. OAuth clients (Applications) become the only structural per-consumer object; users are deployment-scoped and shared across all clients; tenant-carried config moves to deployment config or the client. Refines ADR-0011 (Tenant is no longer a structural GitOps unit) and retires the vestigial per-tenant issuer/audience/key fields."
status: accepted
last_updated: 2026-07-09
date: 2026-07-09
related:
  - ./0011-identity-data-operating-model-and-mcp-scope.md
  - ./0009-remote-authenticated-mcp-service.md
  - ./0005-decentralized-authorization.md
  - ../../guides/tenant-config.md
  - ../architecture.md
---

## Context

The data model has three nested scopes: **Deployment** (an instance — `ds1`, its own MongoDB,
signing keys, Google app, and issuer origin), **Tenant** (a row in that DB), and **Application**
(`oauth_client`, a child of Tenant). This mirrors Okta's *org → authorization server → application*
shape — but Okta needs that depth because it is multi-customer SaaS where one org must host many
cryptographically-isolated customers. We are an internal fps4 IdP: one deployment serves one product
suite.

Two observations make the middle layer redundant:

1. **Tenant buys exactly one thing that Application does not: a shared user pool.** Users are scoped
   to Tenant (`unique {tenantId, email}`) and any client in the tenant can authenticate any user in
   it — that is intra-tenant SSO. Everything else on the Tenant document is either instance-level
   config (`allowedOrigins`, `cookieDomain`, `region`, `idp`) or belongs on the client (`scopes`,
   `redirectUris`, which already live on `oauth_client`).

2. **The issuer and signing keys are already global per deployment, not per tenant.**
   `CONFIG.auth.jwtIssuer` stamps every token; `getActiveKeyPair()` / the JWKS never filter by
   `tenantId`. The per-tenant fields that would make Tenant a real isolation boundary —
   `Tenant.jwtIssuer`, `Tenant.jwtAudience`, `KeyStore.tenantId` — exist on the schemas but are
   **never read**. They are ghosts of a per-tenant-crypto design that was never wired.

The deciding requirement was settled explicitly: **a single deployment will never need to host more
than one isolated user population.** If it did, we would spin up a new deployment (we already have
that primitive — `MAESTRO_DEPLOYMENT_ID`, one Google app per deployment). Given that answer, Tenant
is a pooling primitive we do not need, and keeping it costs a `tenantId` on every collection, a
scoping parameter on every query, and the recurring confusion of "is `iss`/keys per-tenant?" (no).

This is the classic pool-vs-silo multitenancy choice, and we are choosing **silo: the deployment is
the tenant.** That makes us a Keycloak-style single-realm-per-instance IdP.

## Decision

**1. Remove Tenant as a modelled entity.** The scope hierarchy becomes two levels:

| Scope | Is | Isolation |
|---|---|---|
| **Deployment** (`ds1`, …) | the realm: one MongoDB, one active signing key, one issuer origin, one Google app, one user pool | hard — separate instance |
| **Application** (`oauth_client`) | an OAuth client; owns `audience`, `grantTypes`, `redirectUris`, `scopes`, `subject`, `claims` | per-token via `aud` |

Users, credentials, invites, sessions, tokens, audit records are **deployment-scoped** — shared
across every client in the instance. There is no partition between them below the deployment.

**2. Users are deployment-scoped and shared across all clients.** Drop `tenantId` from `users`; the
uniqueness invariant becomes `unique {email}` and the federated-identity index becomes
`unique {identities.provider, identities.subject}`. One person is one user record for the whole
instance and can authenticate against any client in it — SSO is now instance-wide, which is exactly
what a single product suite wants.

**3. `tenantId` is removed from every collection.** `oauth_clients`, `oauth_tokens`,
`oauth_authorizations`, `invites`, `sessions`, `audit_logs`, and the vestigial `key_store.tenantId`
all lose the field. Queries drop the tenant filter.

**4. Tenant-carried config re-homes to deployment config or the client:**

| Former `Tenant` field | New home |
|---|---|
| `allowedOrigins`, `cookieDomain`, `region` | deployment config (env / `CONFIG`); folds into the existing `CORS_ORIGINS` + a `COOKIE_DOMAIN` setting |
| `oauth.registration` (`open\|invite\|closed`) | deployment config (`AUTH_REGISTRATION_MODE`) |
| `oauth.limits` (`tokensPerMinute`, `refreshTokens`, `clientCap`) | deployment config — already `CONFIG.oauth.tenantDefaults`, now simply *the* limits |
| `oauth.idp.provider` (`google\|local`) | deployment config — already one Google app per deployment |
| `oauth.allowedGrantTypes/Scopes/Roles` | the client (`oauth_client.grantTypes/scopes`) already constrains these per app |
| `planId`, `status`, `settings` | dropped (no billing/suspension model for internal deployments) |

**5. Retire the ghost fields.** `Tenant.jwtIssuer`, `Tenant.jwtAudience`, and `KeyStore.tenantId`
are deleted rather than wired. Issuer stays global (`CONFIG.auth.jwtIssuer`); the active signing key
stays global. This is now a documented property, not an accident.

**6. Application becomes the only structural per-consumer object.** ADR-0011 made *tenants + OAuth
clients* the structural, GitOps-provisioned pair. With Tenant gone, **the OAuth client is the sole
structural object** provisioned from seed config; deployment-level config (origins, registration
mode, limits, idp) is instance configuration (env/seed), not a per-row document. The declarative/
imperative seam of ADR-0011 is otherwise unchanged: clients are declarative, users/credentials/keys
remain DB-owned operational state.

**7. Drop tenant-scoping from the management surface.** Remove `list_tenants` from the MCP tool set
and the `/admin/v1` tenant routes; admin reads (`get_stats`, user/client listings) are now
instance-wide. Per-actor operator auth (ADR-0010) and audience-binding (ADR-0009) are unaffected —
they never depended on Tenant.

## Consequences

- **Positive — the model matches reality.** Issuer and keys were always global; the schema now says
  so. No more "is this per-tenant?" ambiguity, and no dead `jwtIssuer`/`jwtAudience`/`tenantId`
  fields inviting the next reader to assume isolation that isn't there.
- **Positive — every query loses a scoping parameter.** `tenantId` threading disappears from ~22
  source files, `tenant-cors.ts` collapses into static CORS config, and the admin/MCP surface sheds
  a whole object type.
- **Positive — SSO is instance-wide by construction**, which is the correct default for a single
  product suite: one identity across every fps4 app in the deployment.
- **Trade-off accepted — no in-DB isolation.** Onboarding a genuinely isolated user population now
  means a new deployment (new DB, keys, origin, Google app, pipeline), not a new row. We accept this
  because it will not happen; if that assumption ever breaks, this ADR is the thing to revisit, and
  the fix is to reintroduce Tenant as a pooling row, not to retrofit per-tenant crypto.
- **Refines ADR-0011.** Tenant is no longer a structural GitOps unit; the OAuth client is the only
  structural per-consumer object. The declarative-structure / imperative-state rule stands.
- **Migration is wide but mechanical** (see below) and touches security-sensitive uniqueness
  indexes, so it is a reviewed, staged change — not a big-bang drop.

## Migration

ds1 is the only deployment and is not yet load-bearing, so this was delivered as a single change (not
the staged rollout a live multi-instance fleet would need) and is explicitly authorised to break
existing user history/registration on ds1.

**Code** (one PR):
- `tenantId` dropped from every collection/model; `tenants` collection + `Tenant` model deleted;
  `tenant-cors.ts` removed. `users.email` becomes globally unique; the federated-identity index
  becomes `{identities.provider, identities.subject}`.
- Tenant config re-homed to deployment env/`CONFIG`: `CORS_ORIGINS` (union of former per-tenant
  `allowedOrigins`), `AUTH_REGISTRATION_MODE`, `AUTH_LOCAL_IDP_ENABLED`, `AUTH_ALLOWED_ROLES`, and
  `CONFIG.oauth.limits`. The vestigial `Tenant.jwtIssuer`/`Tenant.jwtAudience`/`KeyStore.tenantId`
  fields are deleted.
- HTTP surface: `POST /v1/register` and `POST /v1/sessions` (were `/v1/tenants/:tenantId/…`); the
  `/admin/v1` tenant routes and the MCP `list_tenants` tool are removed; `admin:tenants` scope gone.
  The seed config collapses to a flat `{ clients, users }`. `sdk`, `react`, and `console` are updated
  to the tenantId-free API (this is a **breaking** wire change, acceptable pre-GA).

**Data** — `service/scripts/migrate-drop-tenant.ts` (idempotent; supports `--dry-run`):
1. Dedupe `users` by email (and by federated `{provider, subject}`), keeping the most-recently-active
   account and deleting cross-tenant collisions — logged, since history-preservation is not required.
2. `$unset tenantId` from all collections and `principalTenantId` from `audit_logs`.
3. Drop the `tenants` collection.
4. `syncIndexes()` on every model — drops the stale `{tenantId,…}` indexes and builds the new
   globally-unique `{email}` index.

Run it against ds1's Mongo after deploying the new image (take a `docker/backup.sh` snapshot first).
