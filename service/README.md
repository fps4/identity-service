# Component Auth Service

Express-based REST + OAuth service for authentication. One deployment is one realm with a single shared
user pool (ADR-0018).

## Setup

```bash
docker run -d -p 8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory   # the table on a laptop
cd service
npm install
cp .env.example .env   # update secrets; TABLE_NAME / DYNAMODB_ENDPOINT point at DynamoDB Local
npm run db:create      # the table, from src/db/table.ts
npm run build
npm test               # against DynamoDB Local, each file on a table of its own
npm start
```

### Required Environment Variables

| Variable | Description |
| --- | --- |
| `TABLE_NAME` | The DynamoDB table (ADR-0023). A deployment's is the Terraform module's; on a laptop, the one `npm run db:create` makes. |
| `DYNAMODB_ENDPOINT` | DynamoDB Local's URL on a laptop (`http://localhost:8000`). Unset in a deployment, where the function's role reaches AWS. |
| `AWS_REGION` | The deployment's region (set by Lambda); any value for DynamoDB Local. |
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
- `npm run db:create` – Make the table on DynamoDB Local from `src/db/table.ts` (never against a deployment).
- `npm run seed`, `npm run dump-seed`, `npm run manage-users` – the operator CLIs (`scripts/`).
- `npm run bundle`, `npm run bundle:smoke`, `npm run sbom` – the Lambda bundles the Terraform module deploys.
- `npm run backup:decrypt`, `npm run backup:restore` – a restore from the backup Lambda's objects.

## The table

One DynamoDB table ([ADR-0023](../docs/design/decisions/0023-the-store-is-dynamodb.md)), keyed `pk`/`sk`;
every item carries `kind`. The realm's own items live under `realm#<kind>` / `<id>`, maestro's record under
`ws#<workspace_id>#<kind>` / `<id>`, and a `unique` item under `realm#unique#<what>` / `<value>` names the
owner of a value that must be one of a kind (an email, a code digest, a login handle).

- `application` – the first-class product objects (ADR-0020): `name`, default `audience`, and role catalogue; users are assigned to these.
- `user` – local-credential + federated user accounts (unique email through `unique#email`; each linked identity through `unique#identity`; no `roles` field — ADR-0019).
- `assignment` – user↔application entitlements, keyed `<userId>#<applicationId>`: app-scoped roles + status, gating token issuance (ADR-0019/0020); an application's members through `gsi1`.
- `session` – session records, keyed by UUID; swept by the TTL.
- `oauth_client` – OAuth-client **credentials** under an application (`applicationId`; confidential & public), with an optional `audience` override — no role catalogue (ADR-0020); listed per application through `gsi1`.
- `oauth_token` – access/refresh token metadata; a refresh token found by its hash through `gsi1`, counted by type and issue time through `gsi2`; swept by the TTL a day after expiry.
- `oauth_authorization` – an in-flight login; its `state`, `loginToken` and `code` resolve through `unique` items; swept by the TTL.
- `invite` – registration invites (RQ-0013); the code digest through `unique#invite_code`.
- `key_store` – RSA signing key material, keyed by `kid`.
- `audit_log` – the management plane's append-only trail (ADR-0007), keyed by a UUIDv7 so the latest is a reverse key query.
- `principal` – the maestro principal registry (ADR-0022): the maestro principal id (`prn-h-…` / `prn-a-…` / `prn-w-…`), with its kind (`principal_kind` in the item), `status` and what it binds to (unique through `unique#principal_subject`). Rows are retired, never deleted. `user.principalId` / `oauth_client.principalId` point here.
- `outbox` – maestro spine envelopes the registry emits (`PrincipalRegistered`, `PrincipalSuspended`, `PrincipalReinstated`, `SeatOccupancyChanged`) in the same transaction as the change, keyed by `seq`, plus the relay's `delivered` / `delivered_at` / `attempts`; while undelivered, on the sparse `pending` index.
- `counter` – the outbox's per-workspace `seq` (`outbox`) and per-principal `subject_seq` (`subject#<prn>`), advanced in the emitting transaction on the condition that they did not move.

See `../docs/guides/tenant-config.md` for deployment configuration and registering applications & credentials.

Register **applications** (with their role catalogues and credentials), users, and per-user **assignments**
with the idempotent seed loader (`npm run seed`) from `config/seed.yaml` — a nested `applications:` (each with
`credentials:`) / `users:` list, no tenant layer (ADR-0018/0020); roles are app-scoped via assignments, not a
deployment-wide `user.roles` (ADR-0019). Realm-wide settings (`CORS_ORIGINS`, `AUTH_REGISTRATION_MODE`,
`AUTH_LOCAL_IDP_ENABLED`) are deployment env, not DB rows. The seed is an operator's act on maestro's record
(ADR-0022): `npm run seed -- --as=<email>` names the person its events are attributed to (default: the first
user in the file); a re-run emits only what changed.

## Docker

Use `docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up --build` from the repository root to run DynamoDB Local, make the table, and run the service together for local development.
