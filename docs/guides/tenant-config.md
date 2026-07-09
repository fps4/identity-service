---
title: Deployment Configuration Guide
summary: How to configure a deployment of identity-service — the realm-wide env settings, OAuth clients (Applications), local users, Google SSO, registration/invites, roles, and the flat seed config.
status: current
last_updated: 2026-07-09
owners: [architect]
related:
  - docs/reference/api.md
  - docs/design/architecture.md
  - docs/design/decisions/0018-collapse-tenant-into-deployment.md
  - docs/product/RQ-0001-workspace-user-identity-google-sso.md
---

# Deployment Configuration Guide

Since [ADR-0018](../design/decisions/0018-collapse-tenant-into-deployment.md), **one deployment = one
realm = one shared user pool**. There is no `Tenant` entity, no `tenantId`, and no `tenants` collection.
A deployment (`ds1`, …) has its own MongoDB, active signing key, issuer origin, and Google app; **users
are deployment-scoped** (unique by `email`, shared across every client → instance-wide SSO), and the
**OAuth client (Application)** is the only structural per-consumer object.

Configuring a deployment therefore has two parts:

1. **Realm-wide settings** — deployment **environment variables** (`CONFIG`), not a per-row document.
2. **Provisioned objects** — OAuth clients and local users, via the flat **seed config** (`config/seed.yaml`)
   or the [`/admin/v1` management plane](../reference/api.md#admin-v1-management-plane).

## Realm-wide settings (deployment env)

What used to live on a per-tenant `oauth` block is now deployment configuration. The mapping:

| Former per-tenant field | New home (deployment env) | Notes |
| --- | --- | --- |
| `allowedOrigins` | `CORS_ORIGINS` | Comma-separated allow-list of browser origins; a single, deployment-wide list. |
| `oauth.registration` (`open`\|`invite`\|`closed`) | `AUTH_REGISTRATION_MODE` | Default `open`. Governs self-registration (see [Registration & invites](#registration-policy--invites)). |
| `oauth.idp.provider` (`google`\|`local`) | `AUTH_LOCAL_IDP_ENABLED` + the Google app env | Local IdP is on by default; set `AUTH_LOCAL_IDP_ENABLED=false` to disable it. One Google app per deployment (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`). |
| `oauth.allowedRoles` | `AUTH_ALLOWED_ROLES` | Comma-separated role vocabulary; validated at seed time when non-empty (see [User roles](#user-roles-rq-0005)). |
| `oauth.limits.tokensPerMinute` | `OAUTH_MAX_TOKENS_PER_MINUTE` | Deployment-wide access-token rate limit (default 200/min). |
| `oauth.limits.refreshTokens` | `OAUTH_MAX_REFRESH_TOKENS` | Deployment-wide refresh-token budget (default 10000). |
| `oauth.limits.clientCap` | `OAUTH_MAX_CLIENTS` | Deployment-wide cap on registered clients (default 50). |

The Google app credentials and the issuer are service-level, **never** per-consumer:

```
GOOGLE_CLIENT_ID=...           # from Google Cloud Console
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://auth-dev.example.com/oauth2/callback   # register this on the Google app
AUTH_JWT_ISSUER=https://auth-dev.example.com                        # HTTPS issuer; becomes the token `iss`
CORS_ORIGINS=https://app.example.com,https://app.maestro.example.com
AUTH_REGISTRATION_MODE=open                                         # open | invite | closed
AUTH_LOCAL_IDP_ENABLED=true
AUTH_ALLOWED_ROLES=platform_admin,member                           # optional vocabulary
```

## Registering OAuth clients (Applications)

An OAuth client is the registered per-consumer object: it carries the grants it may use, its redirect
URIs, its scopes, and — for user login — the **`audience`** stamped as the token `aud`. Provision clients
via the seed config (below) or the management plane. A raw insert looks like:

```js
db.oauth_clients.insertOne({
  name: "Telemetry Client",
  secretHash: "<hash of plain secret>",   // hashSecret(plainSecret) from service/src/utils/hash.ts
  grantTypes: ["client_credentials"],     // subset of what the deployment allows
  scopes: ["telemetry:read"],
  isConfidential: true
});
```

- `_id` (the `client_id`) auto-generates a UUID when omitted; provide your own only for a stable id.
- A **machine** (`client_credentials`) client is confidential and carries a secret + scopes.
- A **user-login** client (`password` or `authorization_code`) is **public** (PKCE), so `isConfidential`
  may be `false` with no secret, and it **must** carry an `audience`.

Share the `client_id` and plain secret with the product team out-of-band; encourage storing secrets in
the product's own secrets manager. Verify with `POST /oauth2/token`.

## User login via Google SSO (RQ-0001)

Google login is enabled deployment-wide by the Google app env above. To let a consumer authenticate humans
through Google and receive a user identity JWT, register a **public** client that allows the
`authorization_code` grant with an `audience` + redirect URI:

```js
db.oauth_clients.insertOne({
  _id: "client-maestro",
  name: "maestro web",
  grantTypes: ["authorization_code"],
  redirectUris: ["https://app.maestro.example.com/auth/callback"],  // exact-match validated
  audience: "maestro-workspace",                                    // → the token `aud`
  scopes: [],
  isConfidential: false,
  secretHash: ""                                                    // unused by PKCE
});
```

### Values to give the consumer

The consumer's JWT verifier must match what this service mints. maestro, for example, sets these
(`IDENTITY_SERVICE_*`) — a consuming product picks its own variable names:

| consumer env var | Value | Source |
| --- | --- | --- |
| `IDENTITY_SERVICE_JWKS_URL` | `https://auth-dev.example.com/.well-known/jwks.json` | this service's JWKS endpoint |
| `IDENTITY_SERVICE_ISSUER` | `https://auth-dev.example.com` | `AUTH_JWT_ISSUER` above |
| `IDENTITY_SERVICE_AUDIENCE` | `maestro-workspace` | the client's `audience` field |

If `iss` / `aud` / the JWKS URL do not line up exactly, maestro rejects the token as unauthenticated
(401) — there is no fallback.

### Federated users are provisioned on first login (RQ-0011)

The first time a person completes Google login, identity-service **just-in-time provisions** them as a
manageable user record (visible in the console / `/admin/v1`, assignable a role, disable-able) and links
the Google identity to it — no pre-registration needed. Subsequent logins reuse that record. If a user
with the **same email already exists** in the deployment (e.g. a local-password account), the Google
identity is linked onto it **only when Google reports the email verified**; an unverified-email collision
is **denied**, never merged (account-takeover guard). Operators can link/unlink identities manually via
`POST /admin/v1/users/link-identity` / `unlink-identity`. The issued token is unchanged by any of this —
`sub` stays the Google subject. See [ADR-0012](../design/decisions/0012-federated-identity-and-account-linking.md).

## Local username/password login (RQ-0002)

When `AUTH_LOCAL_IDP_ENABLED` is on (the default), register a client that allows the `password` grant
with an `audience` (binds the issued token's `aud`):

```js
db.oauth_clients.insertOne({
  _id: "client-local", name: "local web",
  grantTypes: ["password"], audience: "maestro-workspace",
  redirectUris: [], scopes: [], isConfidential: false, secretHash: ""
});
```

Then users **self-register** (`POST /v1/register`) and **log in** via the `password` grant. The issued
token is identical in shape to the Google-SSO token (`email` + stable `sub` + `iss` + `aud` + `exp`), so a
consumer like maestro verifies it the same way.

Operators manage credentials with the CLI (no email channel yet):

```bash
cd service
npm run manage-users -- create        --email=u@x.test --password=...
npm run manage-users -- set-password  --email=u@x.test --password=...
npm run manage-users -- lock|unlock|disable|enable|delete --email=u@x.test
```

## Registration policy & invites

Self-registration is governed **deployment-wide** by **`AUTH_REGISTRATION_MODE`**: `open` (default —
anyone may register), `invite` (a valid operator-issued invite code is required), or `closed` (admin-plane
creation only).

On an `invite` deployment, operators mint codes on the management plane — `POST /admin/v1/invites` (or the
`create_invite` MCP tool / the console) — and send them out-of-band (email, chat); **no mail provider is
needed**. A code can be email-bound, stamp roles (validated against `AUTH_ALLOWED_ROLES`), allow multiple
uses (cohorts), and expires after 7 days by default. The code is **shown once**; list and revoke via
`GET /admin/v1/invites` and `POST /admin/v1/invites/{id}/revoke`. Invitees pass the code as `inviteCode`
on the register call; an email-bound redemption also marks the address verified (ADR-0013).

Two behaviours to plan for on non-`open` deployments:

- **Google-first sign-in is denied for new people** — a federated login only succeeds for an existing
  user; a new Google identity is redirected back with `error=access_denied`. The invitee registers
  locally with their code first; their Google account then auto-links on the verified matching email at
  next login (ADR-0012). Point your login UI's "sign up" path at the invite form.
- Invites are **runtime operational data** — minted via the admin plane, audited (`invite.create` /
  `invite.redeem` / `invite.revoke`), and never part of the seed file.

## User roles (RQ-0005)

A local user can carry a list of **coarse, deployment-scoped roles** that are stamped into the user
token's **`roles`** claim (a JSON array of strings). identity-service **asserts** roles but does **not**
enforce them — each consuming product maps roles to its own permissions
([ADR-0005](../design/decisions/0005-decentralized-authorization.md)). The claim is omitted when a user has no
roles, and is re-read on every token issuance (including refresh), so a change applies on next refresh.

Optionally declare a deployment **`AUTH_ALLOWED_ROLES`** vocabulary. When non-empty it is validated at seed
time — a user role outside the list is rejected; when empty/absent, any role string is accepted.

```
AUTH_ALLOWED_ROLES=platform_admin,member
```

Roles are provisioned by the operator (no HTTP API, [ADR-0003](../design/decisions/0003-seed-config-not-admin-api.md)):

- **Seed config:** add `roles: [..]` under a user in `config/seed.yaml` (applies to **newly created**
  users; re-running the seed leaves existing users untouched).
- **CLI (existing users):**

  ```bash
  cd service
  npm run manage-users -- set-roles --email=u@x.test --roles=platform_admin,member
  npm run manage-users -- set-roles --email=u@x.test --roles=   # clears all roles
  ```

A consumer reads `roles` from the verified token and authorizes accordingly; it never calls back to
identity-service to check a permission.

## Bulk provisioning via seed config (RQ-0004)

For more than a one-off client, use the **seed config** instead of hand-running DB inserts. It is a **flat**
list of OAuth clients and local users — **no `tenants:` layer** (ADR-0018). Copy the committed template to a
gitignored real file, fill it in, and run the idempotent loader:

```bash
cp config/seed.example.yaml config/seed.yaml     # gitignored; never committed
# set referenced secrets in the environment / .env, e.g. SEED_DEMO_PASSWORD, SEED_ADMIN_PASSWORD
cd service
npm run seed                                      # validates, then upserts clients + adds users
```

The file's shape:

```yaml
clients:
  - id: demo-web
    name: Demo Web
    grantTypes: [password]              # local email/password login (RQ-0002)
    audience: demo-workspace            # REQUIRED for password/authorization_code — becomes the token `aud`
    redirectUris: []
    isConfidential: false

users:
  - email: demo@fps4.nl
    password: ${SEED_DEMO_PASSWORD}     # ${ENV_VAR} references resolved at run time, stored scrypt-hashed
    status: active
    roles: [member]                     # RQ-0005: coarse roles → token `roles` claim
```

Re-running upserts clients and **leaves existing users untouched** (use `npm run manage-users set-password`
to change a password). The loader is operator-run against the database — there is **no HTTP seeding endpoint**
([ADR-0003](../design/decisions/0003-seed-config-not-admin-api.md)). It reads `MONGO_URI`, so run it where it
can reach the target Mongo (locally against the published port, or inside the docker network).

## Operational Tips

- Keep client configuration and the deployment env in version control (e.g. the infra repo) to track history.
- Rotate client secrets periodically — `POST /admin/v1/clients/{id}/rotate-secret` (or the seed) — and redistribute.
- Monitor structured logs for `issued client credentials token` events to validate adoption and spot unexpected grants.

For full architecture context, review [architecture.md](../design/architecture.md). For endpoint contracts, see [api.md](../reference/api.md).
> **Tip:** A client's `_id` is auto-generated as a UUID when omitted. Provide one explicitly only if you need a stable identifier determined outside the service.
