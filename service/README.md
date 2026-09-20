# Component Auth Service

Express-based REST + OAuth service for authentication. One deployment is one realm with a single shared
user pool (ADR-0018).

## Setup

```bash
cd service
npm install
cp .env.example .env   # update secrets & Mongo connection
npm run build
npm test
npm start
```

### Required Environment Variables

| Variable | Description |
| --- | --- |
| `MONGO_URI` | Connection string to the MongoDB host (no database appended). |
| `MONGO_DB_NAME` | Database that stores users, clients, and sessions. |
| `AUTH_JWT_SECRET` | Legacy secret used to sign session JWTs (HS256); kept for compatibility. |
| `AUTH_JWT_ISSUER` | JWT/OAuth issuer claim. |
| `AUTH_JWT_AUDIENCE` | JWT/OAuth audience claim. |
| `SESSION_TTL_MINUTES` | Session lifetime in minutes (legacy flows). |
| `OAUTH_ACCESS_TOKEN_TTL_SEC` | Access token lifetime in seconds. |
| `OAUTH_REFRESH_TOKEN_TTL_SEC` | Refresh token lifetime (future use). |
| `OAUTH_MAX_CLIENTS` | Deployment-wide registered-client cap. |
| `OAUTH_MAX_TOKENS_PER_MINUTE` | Deployment-wide access-token rate limit. |
| `OAUTH_MAX_REFRESH_TOKENS` | Deployment-wide refresh-token cap. |
| `OAUTH_KEY_PASSPHRASE` | Optional passphrase to encrypt stored private keys. |
| `OAUTH_KEY_ROTATION_HOURS` | Desired key rotation cadence. |

Optional:
- `CORS_ORIGINS` – comma-separated, deployment-wide allow-list of browser origins.
- `AUTH_REGISTRATION_MODE` – self-registration mode: `open` (default) \| `invite` \| `closed`.
- `AUTH_LOCAL_IDP_ENABLED` – enable the local email/password IdP (default `true`).
- `AUTH_ALLOWED_ROLES` – comma-separated role vocabulary validated at seed time (optional).
- `LOG_LEVEL`, `LOG_PRETTY` – logging configuration.
- `OAUTH_CLIENT_CREDENTIALS_SCOPE` – global scopes auto-assigned when none requested.

maestro's record ([ADR-0022](../docs/design/decisions/0022-maestro-principal-ids-and-lifecycle-events.md)) —
the same names the spine's handlers and maestro-specs read, so one tenant module configures every component:

| Variable | Description |
| --- | --- |
| `MAESTRO_WORKSPACE_ID` | This deployment's workspace on maestro's record, `ws-<realm slug>`. Default `ws-identity-dev`; a tenant sets its own. |
| `MAESTRO_ACCOUNTABLE` | The `prn-h-…` of the human answerable for acts by a **machine** principal (an agent over the MCP, a pipeline with an admin credential). **No default**: without it a machine actor's act is refused and the refusal logged. |
| `MAESTRO_CONSEQUENCE_CLASS` | The consequence class every event carries. Default `c1`. |
| `RECORD_SINK` | `local` (default) relays the outbox on an interval into `RECORD_ARCHIVE_DIR` with in-process delivery — a laptop's spine; `s3` into `ARCHIVE_BUCKET` / `ARCHIVE_PREFIX` / `EVENTS_TOPIC_ARN` (the spine module's outputs); `off` writes the outbox and leaves it to the scheduled relay Lambda. |
| `RECORD_ARCHIVE_DIR` | The filesystem archive for `local`. Default `./archive` (gitignored); `spine-verify ./archive --workspace ws-identity-dev` reads it with the service off. |
| `RECORD_SINK_INTERVAL_MS` | How often the in-process relay drains. Default `2000`. |

## Scripts

- `npm run dev` – Watch mode with `tsx`.
- `npm run build` – Type-check and emit JavaScript to `dist/`.
- `npm start` – Run compiled server (`dist/server.js`).

## Mongo Collections

- `applications` – the first-class product objects (ADR-0020): `name`, default `audience`, and role catalogue; users are assigned to these.
- `users` – local-credential + federated user accounts (globally-unique email; no `roles` field — ADR-0019).
- `assignments` – user↔application entitlements, keyed on `applicationId`: app-scoped roles + status, gating token issuance (ADR-0019/0020).
- `sessions` – session records, keyed by UUID.
- `oauth_clients` – OAuth-client **credentials** under an application (`applicationId`; confidential & public), with an optional `audience` override — no role catalogue (ADR-0020).
- `oauth_tokens` – access/refresh token metadata.
- `key_store` – RSA signing key material.
- `principals` – the maestro principal registry (ADR-0022): `_id` is the maestro principal id (`prn-h-…` / `prn-a-…` / `prn-w-…`), with `kind`, `status` and what it binds to. Rows are retired, never deleted. `users.principalId` / `oauth_clients.principalId` point here.
- `outbox` – maestro spine envelopes the registry emits (`PrincipalRegistered`, `PrincipalSuspended`, `PrincipalReinstated`, `SeatOccupancyChanged`) in the same transaction as the change, plus the relay's `delivered` / `delivered_at` / `attempts`.
- `counters` – the outbox's per-workspace `seq` and per-principal `subject_seq`.

See `../docs/guides/tenant-config.md` for deployment configuration and registering applications & credentials.

Register **applications** (with their role catalogues and credentials), users, and per-user **assignments**
with the idempotent seed loader (`npm run seed`) from `config/seed.yaml` — a nested `applications:` (each with
`credentials:`) / `users:` list, no tenant layer (ADR-0018/0020); roles are app-scoped via assignments, not a
deployment-wide `user.roles` (ADR-0019). Realm-wide settings (`CORS_ORIGINS`, `AUTH_REGISTRATION_MODE`,
`AUTH_LOCAL_IDP_ENABLED`) are deployment env, not DB rows. The seed is an operator's act on maestro's record
(ADR-0022): `npm run seed -- --as=<email>` names the person its events are attributed to (default: the first
user in the file); a re-run emits only what changed.

## Docker

Use `docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up --build` from the repository root to run MongoDB and the service together for local development.
