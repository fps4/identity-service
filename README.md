# Component Auth

Multi-tenant authentication building blocks shared across products. The project ships a standalone service for session management plus a lightweight SDK for consumers.

## Project Layout

```
component-auth/
 ├── docker/           # Docker Compose base + env-specific overrides
 ├── service/          # REST API + Docker assets
 │    ├── src/         # Express app, core logic, models
 │    ├── Dockerfile   # Container build
 ├── sdk/              # Headless TypeScript client for the API
 │    └── src/
 ├── react/            # Optional React UI: drop-in <Login/> (@fps4/component-auth-react)
 │    └── src/
 ├── docs/             # Architecture notes & API reference
 └── README.md
```

## Quick Start

1. Copy `service/.env.example` to `.env` and set values:
   - `MONGO_URI`, `MONGO_DB_NAME`
   - `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`
   - OAuth settings: token TTLs, tenant limits, optional key passphrase (see comments in `.env.example`)
   - Optionally update `SESSION_TTL_MINUTES`, `CORS_ORIGINS`
2. Install dependencies & build:

   ```bash
   cd service
   npm install
   npm run build
   npm test
   npm start
   ```

3. (Optional) Run with Docker:

   ```bash
   docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up --build
   ```
   Use `docker compose -f docker/compose.yaml -f docker/compose.dev.yaml down` to stop containers.

The service listens on `PORT` (default `7305`). Health check at `GET /health`.

## API Summary

- `POST /oauth2/token` – client credentials grant issuing RS256 access tokens.
- `GET /.well-known/jwks.json` – JWKS for verifying issued tokens.
- `POST /v1/tenants/:tenantId/sessions` – validate tenant, persist session, issue legacy session JWT (in migration).
- `PATCH /v1/sessions/:sessionId` – attach contact identifiers or cookie context.
- See `docs/api.md` for full payloads and responses.

## SDK Usage

```ts
import { ComponentAuthClient } from '@fps4/component-auth';

const client = new ComponentAuthClient({
  baseUrl: 'https://auth.example.com',
  defaultTenantId: 'tenant-123'
});

const session = await client.createSession({ visitorId: 'visitor-001' });
await client.updateSession({ sessionId: session.sessionId, contactId: 'contact-42' });

const token = await client.requestClientCredentialsToken({
  clientId: process.env.CORE_AUTH_CLIENT_ID!,
  clientSecret: process.env.CORE_AUTH_CLIENT_SECRET!,
  scope: ['telemetry:write']
});

console.log(token.accessToken);
```

### User login via Google (RQ-0001)

A browser frontend drives the redirect login with PKCE and forwards the issued token as
`Authorization: Bearer` to its own API:

```ts
// 1. Begin: stash the verifier/state, then navigate to Google.
const { authorizationUrl, codeVerifier, state } = await client.beginGoogleLogin({
  clientId: 'client-maestro',
  redirectUri: 'https://app.example.com/auth/callback'
});
sessionStorage.setItem('pkce', JSON.stringify({ codeVerifier, state }));
window.location.assign(authorizationUrl);

// 2. On the redirect back (…/auth/callback?code=…&state=…): exchange the code.
const { codeVerifier, state } = JSON.parse(sessionStorage.getItem('pkce')!);
if (params.get('state') !== state) throw new Error('state mismatch');
const token = await client.completeGoogleLogin({
  code: params.get('code')!,
  codeVerifier,
  redirectUri: 'https://app.example.com/auth/callback',
  clientId: 'client-maestro'
});
// token.accessToken → send as `Authorization: Bearer`; token.refreshToken → client.refreshUserToken(...)
```

Run `npm install && npm run build` inside `sdk/` to compile distributable assets. Consumers need a `fetch` implementation (Node 18+ or polyfill); the login helpers also require WebCrypto (browser or Node 18+).

### React login component

For React consumers, `@fps4/component-auth-react` (in `react/`) ships a drop-in `<Login/>` for the
local email/password IdP — so apps don't rebuild the form. It's a **separate, opt-in** package (React
peer dependency only); the headless SDK stays UI-free.

```tsx
import { Login } from '@fps4/component-auth-react';

<Login
  baseUrl="https://auth-dev.example.com"
  clientId="client-local"
  onSuccess={(token) => sessionStorage.setItem('access_token', token.accessToken)}
/>
```

See [`react/README.md`](react/README.md) for styling (Tailwind/shadcn) and the full API.

## Docs

- `docs/architecture.md` – overall architecture and OAuth components.
- `docs/api.md` – endpoint contract.
- `docs/tenant-config.md` – tenant onboarding & OAuth configuration.
- `docs/requirements/` – open requirements for pickup. `RQ-0001` adds user identity via Google SSO (OIDC), issued as a JWT maestro's authenticated edge verifies.
- `tests/` – manual harness + scripts for integration checks on deployed environments.

## Migration Notes

Existing authentication logic in `product-chatbot` maps directly onto this service:

- `packages/authorizer-core` → `service/src/core`
- `services/authorizer` → `service/src/server.ts` and routes/models

Downstream products should replace direct module imports with API calls through the service or the SDK to decouple authentication concerns.

## Deployments

Deploys are **manual over SSH** to the lab docker host (`ds1`), the same pattern the sibling
fps4 stacks use (maestro, copilot). The GitHub Actions self-hosted-runner workflow is
**disabled** — kept fully commented in `.github/workflows/deploy.yml` so it can be restored if
we move back to CI-driven deploys.

Secrets live in a **gitignored `docker/.env`** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
`OAUTH_KEY_PASSPHRASE`, the HTTPS `AUTH_JWT_ISSUER`, etc.) — never committed. Build context
(`../service`) and `${VAR}` interpolation resolve locally before being sent to the remote daemon.

```bash
# Deploy to ds1 from the Mac (runs against ds1's daemon over SSH)
export DOCKER_HOST=ssh://ds1
docker compose --env-file docker/.env \
  -f docker/compose.yaml -f docker/compose.dev.yaml up -d --build   # dev overlay
docker compose -f docker/compose.yaml -f docker/compose.dev.yaml ps

# Production overlay (same host today): swap compose.dev.yaml → compose.prod.yaml
```

Prerequisites on `ds1`: the external `net-public` network must exist
(`docker network inspect net-public`), and a public HTTPS hostname via the Cloudflare Tunnel —
required both for Google's OAuth redirect URI and for maestro's `COMPONENT_AUTH_JWKS_URL` /
`COMPONENT_AUTH_ISSUER` / `COMPONENT_AUTH_AUDIENCE`. The service listens on `7305`.
