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

## Scripts

- `npm run dev` – Watch mode with `tsx`.
- `npm run build` – Type-check and emit JavaScript to `dist/`.
- `npm start` – Run compiled server (`dist/server.js`).

## Mongo Collections

- `users` – local-credential + federated user accounts (globally-unique email).
- `sessions` – session records, keyed by UUID.
- `oauth_clients` – registered OAuth clients (confidential & public).
- `oauth_tokens` – access/refresh token metadata.
- `key_store` – RSA signing key material.

See `../docs/guides/tenant-config.md` for deployment configuration and registering OAuth clients.

Register OAuth clients and users with the idempotent seed loader (`npm run seed`) from `config/seed.yaml`
— a flat `clients:` / `users:` list, no tenant layer (ADR-0018). Realm-wide settings (`CORS_ORIGINS`,
`AUTH_REGISTRATION_MODE`, `AUTH_LOCAL_IDP_ENABLED`, `AUTH_ALLOWED_ROLES`) are deployment env, not DB rows.

## Docker

Use `docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up --build` from the repository root to run MongoDB and the service together for local development.
