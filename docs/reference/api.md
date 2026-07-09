---
title: identity-service API
summary: The identity-service endpoint contract — OAuth 2.0 token issuance, legacy sessions, JWKS, and the authenticated /admin/v1 management plane.
status: current
last_updated: 2026-07-09
owners: [architect]
related:
  - docs/design/architecture.md
  - docs/guides/tenant-config.md
  - docs/design/decisions/0018-collapse-tenant-into-deployment.md
  - docs/product/RQ-0001-workspace-user-identity-google-sso.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
---

# identity-service API

The service exposes OAuth 2.0 endpoints under `/oauth2/*`, legacy session routes under `/v1/*`, and an
authenticated management plane under `/admin/v1/*` (ADR-0007). Responses are JSON unless noted otherwise.

## Authentication

The **token-issuance and session surfaces** (`/oauth2/*`, `/v1/*`) rely on network-level controls
(private network, API gateway, etc.) plus the per-grant client authentication described below; a
consumer's own `Authorization` header is passed to logging but not verified here.

The **management plane** (`/admin/v1/*`) is authenticated: every request must present an admin-scoped
`client_credentials` bearer token (see [Management plane](#admin-v1-management-plane)). It is also
network-restricted — kept off the public token-issuance surface by default.

## Headers

- `Content-Type: application/json`
- `Origin` – checked against the deployment's `CORS_ORIGINS` allow-list.

---

## `POST /oauth2/token`

Issue OAuth 2.0 tokens. Three grants are supported: **`client_credentials`** (machine tokens),
**`authorization_code`** (user login via Google SSO — RQ-0001), and **`refresh_token`** (rotate a
user token).

> **Prerequisite:** the client must be registered with the grant in its `grantTypes` (and, for user
> login, an `audience`). See [Deployment Configuration](../guides/tenant-config.md).

### `grant_type=client_credentials`

- `Content-Type: application/x-www-form-urlencoded`
- Client authentication via HTTP Basic (`Authorization: Basic base64(client_id:client_secret)`) **or** `client_id` and `client_secret` form fields.
- Body parameters:
  - `grant_type=client_credentials`
  - `scope` (optional, space-delimited string; subset of client’s registered scopes)

Response (`200`):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "telemetry:write telemetry:read"
}
```

### `grant_type=authorization_code` (user login — PKCE)

Completes the Google login started at [`GET /oauth2/authorize`](#get-oauth2authorize). The client is
**public** — the PKCE `code_verifier` authenticates the exchange, not a client secret.

- `Content-Type: application/x-www-form-urlencoded`
- Body parameters: `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri`.

Response (`200`):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "k7b3...opaque",
  "refresh_expires_in": 2592000,
  "scope": ""
}
```

The `access_token` is an RS256 JWT carrying **`email`**, the stable Google **`sub`** (the JWT
`sub` claim), **`iss`**, the consumer-bound **`aud`** (the client's configured `audience`), and
**`exp`** + `iat` — verifiable via [`/.well-known/jwks.json`](#get-well-knownjwksjson).

On first login the person is **just-in-time provisioned** as a manageable user record and the Google
identity is linked to it; a subsequent login with a verified email that matches an existing account
links onto that account rather than creating a duplicate (RQ-0011). This is issuer-internal — the token
claims above are **unchanged**. Because provisioning yields a real user, a `disabled`/`locked` status
and the user's app assignment now apply to Google logins exactly as to password logins.

**Entitlement gate (ADR-0019).** Every user grant is gated: after the user authenticates, issuance
requires an **active [assignment](#admin-v1-management-plane)** for the target client, else
`access_denied` ("user is not assigned to this application"). JIT-provisioning a Google user creates the
identity but **not** an assignment — a new person with no assignment authenticates but is refused a token
until one is granted (by an operator or an invite). This is a hard, global gate; machine
(`client_credentials`) tokens have no user and are unaffected.

The token carries a **`roles`** claim — a JSON array of the user's **app-scoped** roles *in this
application*, sourced from the assignment's `roles` (a subset of the client's role catalogue, ADR-0019),
**omitted** when the assignment grants none. Roles are advisory identity assertions: identity-service does
**not** enforce them — each consuming product maps roles to its own permissions
([ADR-0005](../design/decisions/0005-decentralized-authorization.md)). The claim is additive (a verifier
that ignores it is unaffected) and the assignment is re-read on every issuance (including `refresh_token`),
so a role change — or a revoked/suspended assignment (which then denies refresh) — applies on the next
refresh.

### `grant_type=password` (local login — RQ-0002)

Email + password login against identity-service's own credential store, when the deployment enables the
**local** IdP. Issues the same user token shape as the Google flow.

- `Content-Type: application/x-www-form-urlencoded`
- Body parameters: `grant_type=password`, `username` (the email), `password`, `client_id` (must allow the `password` grant and have an `audience`).
- Response: same shape as `authorization_code`.
- Bad email and bad password return the **same** `invalid_grant` (no user enumeration); too many failures temporarily **lock** the account.

### `grant_type=refresh_token`

Rotates a user token. The presented refresh token is single-use; a fresh access + refresh pair is
returned. A refresh fails once its session is revoked or expired, or once the user's assignment for the
client is **revoked or suspended** (`access_denied` — ADR-0019).

- `Content-Type: application/x-www-form-urlencoded`
- Body parameters: `grant_type=refresh_token`, `refresh_token`, `client_id`.
- Response: same shape as `authorization_code`.

### Errors

- `400 invalid_request` – missing/unsupported `grant_type` or required parameter.
- `400 invalid_scope` – requested scope not permitted.
- `400 invalid_grant` – bad/expired/used authorization code, failed PKCE, or invalid/revoked refresh token.
- `403 access_denied` – the authenticated user has no **active assignment** to this application
  ("user is not assigned to this application") — password, authorization-code, and refresh grants (ADR-0019).
- `401 invalid_client` – bad client credentials (client-credentials grant).
- `400 unauthorized_client` – grant not allowed for the client, or client has no `audience`.
- `429 slow_down` – token rate limit exceeded.
- `500 server_error` – unexpected failure.

---

## `GET /oauth2/authorize`

Browser entry point for user login (RQ-0001). Validates the client and the registered
`redirect_uri`, then **302-redirects** the browser to Google to authenticate.

### Query parameters

- `client_id` – an OAuth client allowing the `authorization_code` grant.
- `redirect_uri` – must be pre-registered on the client (exact match).
- `code_challenge` – PKCE challenge; `code_challenge_method=S256` (the only supported method).
- `state` (recommended) – opaque CSRF value, echoed back unchanged on the consumer redirect.
- `scope` (optional) – space-delimited subset of the client's scopes.

On success: `302` to Google. On a bad/unregistered request: a JSON OAuth error (no redirect, since
an unvalidated `redirect_uri` is never trusted).

---

## `GET /oauth2/callback`

Where Google redirects back after authentication. The service exchanges Google's `code`, verifies
its `id_token` (signature, `iss`, `aud`, `exp`, `nonce`), then **302-redirects** the browser to the
consumer's `redirect_uri` with a single-use `code` (and the echoed `state`). If Google
authentication fails, it redirects back with `?error=access_denied` and issues **no** token.

---

## `POST /oauth2/revoke`

Revoke a refresh token and its session (RFC 7009). Always `200`, even for an unknown token.

- `Content-Type: application/x-www-form-urlencoded`
- Body: `token` (the refresh token).

Revoking cascades to the session, so any sibling refresh token is also dead. Already-issued access
JWTs remain valid until `exp` (≤ 15 min) — they are stateless and not checked against the store.

---

## `POST /v1/register`

Self-service local-credential registration (RQ-0002). Creates a user when the deployment has the
**local** IdP enabled. Login is the separate `password` grant; registration does not return a token.

Gated by the deployment's **registration mode** (`AUTH_REGISTRATION_MODE`, RQ-0013): `open` (default —
anyone may register, as before), `invite` (a valid operator-issued invite code is required), or
`closed` (no self-registration). Modes other than `open` also stop federated (Google) logins from
JIT-provisioning **new** users — the browser is redirected back with `error=access_denied`; existing
users log in unchanged.

### Request Body

```json
{ "email": "reviewer@example.com", "password": "at-least-10-chars", "inviteCode": "V7QK-3MHP-XA2D" }
```

`inviteCode` is required when the mode is `invite` and ignored otherwise. Entry is forgiving: case and
dashes don't matter. Redeeming a code creates the user **and** an **assignment** to the invite's target
`clientId` with the invite's `roles` (ADR-0019) — so the invitee lands directly into one application; an
**email-bound** invite additionally requires the matching address and sets `emailVerified: true` (the
operator sent the code there — ADR-0013).

### Response (`201`)

```json
{ "id": "f3ede70f-...", "email": "reviewer@example.com" }
```

`id` is the stable subject id (the token `sub` at login).

### Errors

- `400 invalid_email` / `400 weak_password` – fails validation (password shorter than the configured minimum).
- `400 local_idp_disabled` – the deployment has not enabled the local IdP (`AUTH_LOCAL_IDP_ENABLED=false`).
- `403 registration_closed` – the deployment does not allow self-registration.
- `403 invite_required` – the deployment is invite-only and no code was presented.
- `403 invalid_invite` – the code is unknown, expired, revoked, exhausted, **or bound to a different
  email** — deliberately one generic answer, so codes cannot be probed for state (ADR-0013).
- `409 email_taken` – an account with this email already exists.
- `429 slow_down` – registration rate limit exceeded (checked before any invite use is consumed).

> **Password reset** has no email channel yet: an operator resets credentials via the
> `service/scripts/manage-users.ts` CLI (`set-password`, `lock`, `unlock`, `disable`).

---

## `POST /v1/sessions`

Create a session and issue a session JWT (legacy path; tokens will align with OAuth responses in a future release).

### Request Body

```json
{
  "visitorId": "optional string",
  "subject": "optional string",
  "clientMeta": {
    "ip": "1.2.3.4",
    "userAgent": "Mozilla/5.0"
  }
}
```

`clientMeta` is optional; headers such as `User-Agent`, `Sec-CH-UA*`, and `X-Forwarded-For` are captured automatically.

### Response (`201`)

```json
{
  "sessionId": "b9c4d3fe-...",
  "token": "jwt string",
  "expiresIn": 899,
  "expiresAt": "2024-04-20T08:30:00.000Z",
  "visitorId": "f3ede70f-..."
}
```

### Errors

- `400` – invalid input (invalid body).
- `500` – service misconfiguration (missing JWT secret) or unexpected error.

---

## `PATCH /v1/sessions/{sessionId}`

Update an existing session with additional identifiers or cookie data.

### Path Parameters

- `sessionId` – the session identifier to update.

### Request Body

```json
{
  "contactId": "optional string",
  "cookies": {
    "analytics_id": "abc123"
  }
}
```

### Response (`200`)

```json
{
  "sessionId": "b9c4d3fe-...",
  "updated": {
    "contactId": "user-123",
    "context": {
      "analytics_id": "abc123"
    },
    "updatedAt": "2024-04-20T08:45:12.000Z"
  }
}
```

### Errors

- `400` – no fields supplied or invalid payload.
- `404` – session not found.
- `500` – unexpected error.

---

## `GET /health`

Simple status endpoint returning `{ "status": "ok" }`. Useful for orchestrators and monitoring.

---

## `GET /.well-known/jwks.json`

Returns the JSON Web Key Set (JWKS) for verifying RS256 tokens issued by the service.

### Response

```json
{
  "keys": [
    {
      "kid": "7a2c4a4f-...",
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

---

<a id="admin-v1-management-plane"></a>

## `/admin/v1/*` — management plane (ADR-0007)

The authenticated, audited surface for day-2 operations: clients, users, signing keys, and
statistics. Mounted at `/admin/v1` (override with `ADMIN_API_BASE_PATH`; disable the whole surface with
`ADMIN_API_ENABLED=false`). The HTTP API, the [MCP server](../design/architecture.md#management-plane-adr-0007),
and the [admin console](../../console/README.md) all sit on the same service layer, auth, and audit path.

### Authentication & scopes

- Every request must carry `Authorization: Bearer <token>`, an access token minted by this service
  (verified against its own JWKS). The plane accepts **two principal kinds** (ADR-0010):
  - a **machine principal** — a **`client_credentials`** token (`cid`) for a client whose token carries an
    admin scope (agents/MCP + the console's break-glass token); or
  - an **operator principal** — a **user identity token** (`sub`, no `cid`) whose `roles` claim contains a
    configured operator role (`ADMIN_OPERATOR_ROLES`, default `platform_admin`), mapped to the `admin`
    superscope. Under [ADR-0019](../design/decisions/0019-application-assignments-and-app-roles.md) that
    claim is app-scoped: `platform_admin` is a role in the **`identity-console`** application's catalogue,
    and the operator holds an `identity-console` assignment granting it (folding ADR-0010). This is how the
    admin console attributes each action to a **human** (the audit `principalSubject` is the operator's `sub`).
- The superscope **`admin`** (configurable via `ADMIN_API_SCOPE`) satisfies any admin route. For
  least-privilege agents, granular per-area scopes also satisfy their own routes:
  `admin:clients`, `admin:users`, `admin:keys`, `admin:stats`. (Operator principals are
  granted the superscope.)
- Missing/invalid/expired token → `401 unauthorized`; a valid token that is neither an admin-scoped
  machine token nor an operator-role user token, or one lacking the required scope → `403 forbidden`.
- Every **mutation** is written to the append-only `audit_logs` collection (principal, action, method,
  path, target, status).

### Endpoints

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /clients` | `admin:clients` | List OAuth clients (including each client's role catalogue). |
| `POST /clients` | `admin:clients` | Register a client; body accepts `roles: AppRole[]` — the app's **role catalogue** (`AppRole = { key, name?, description? }`, ADR-0019). **The client secret is returned once** — only its hash is persisted. |
| `POST /clients/{id}/rotate-secret` | `admin:clients` | Rotate a client secret (returns the new secret once). |
| `GET /clients/{id}/roles` | `admin:clients` | Read the client's role catalogue (`AppRole[]`, ADR-0019). |
| `PUT /clients/{id}/roles` | `admin:clients` | Replace the client's role catalogue (`{ roles: AppRole[] }`, ADR-0019). |
| `GET /clients/{id}/members` | `admin:clients` | List the users assigned to this application and their app-scoped roles (ADR-0019). |
| `GET /users` | `admin:users` | List users (local + federated), including each user's linked `identities[]`; never returns `passwordHash`. Users no longer carry a `roles` field (ADR-0019). |
| `POST /users` | `admin:users` | Create a local user — body `{ email, password }` (**no** `roles`; entitlement is granted separately via an assignment — ADR-0019). |
| `POST /users/reset-password` | `admin:users` | Reset a local user's password (`{ email, password }`). |
| `POST /users/status` | `admin:users` | Set user status (`active` \| `disabled`) — enforced on **all** login paths, Google included (RQ-0011). |
| `POST /users/unlock` | `admin:users` | Clear brute-force lockout counters. |
| `POST /users/link-identity` | `admin:users` | Link a federated identity onto a user (`{ email, provider:"google", subject, identityEmail?, emailVerified? }`); `409 identity_linked` if already owned (RQ-0011). |
| `POST /users/unlink-identity` | `admin:users` | Remove a linked federated identity (`{ email, provider:"google", subject }`) (RQ-0011). |
| `POST /assignments` | `admin:users` | Assign a user to an application (ADR-0019): `{ email, clientId, roles? }` — creates the `active` assignment (unique per `{user, client}`); `roles` must be a subset of the client's catalogue. |
| `POST /assignments/update` | `admin:users` | Update an existing assignment: `{ email, clientId, roles?, status? }` (`status`: `active` \| `suspended`). |
| `POST /assignments/revoke` | `admin:users` | Revoke a user's assignment to an application: `{ email, clientId }` — denies further token issuance for that app. |
| `GET /assignments?email=` | `admin:users` | List a user's assignments (the applications they may reach and their per-app roles). |
| `POST /invites` | `admin:users` | Mint a registration invite (RQ-0013): `{ clientId, roles?, email?, maxUses?, expiresInHours?, note? }`. **`clientId` is required** — redeeming creates an assignment to it (ADR-0019); `roles` must be a subset of that client's catalogue. **The code is returned once** — only its digest is persisted. Defaults: single-use, 7-day expiry. |
| `GET /invites` | `admin:users` | List invites (each includes its target `clientId`) with derived `status` (`pending` \| `redeemed` \| `expired` \| `revoked`) and `usedCount`; never the code. |
| `POST /invites/{id}/revoke` | `admin:users` | Revoke an invite so no further redemptions succeed. |
| `POST /keys/rotate` | `admin:keys` | Mint a new active signing key; demote the previous to `inactive`. |
| `GET /keys` | `admin:keys` | Inspect `key_store` status. |
| `GET /stats` | `admin:stats` | Aggregate counts for the dashboards (see below). |
| `GET /audit` | `admin:stats` | Query the audit log. |

`GET /stats` returns rollups for the console dashboards:

```json
{
  "clients":     { "total": 9 },
  "users":       { "total": 120, "locked": 1, "disabled": 2 },
  "assignments": { "active": 143 },
  "tokens":      { "accessLastHour": 87, "accessLastDay": 1432, "activeRefresh": 64 },
  "keys":        { "active": 1 },
  "at": "2026-06-23T02:30:00.000Z"
}
```
