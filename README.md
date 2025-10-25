# Core Auth

Multi-tenant authentication building blocks shared across products. The project ships a standalone service for session management plus a lightweight SDK for consumers.

## Project Layout

```
core-auth/
 ├── service/          # REST API + Docker assets
 │    ├── src/         # Express app, core logic, models
 │    ├── Dockerfile   # Container build
 │    └── infra/       # Local orchestration (docker-compose, etc.)
 ├── sdk/              # TypeScript client for the API
 │    └── src/
 ├── docs/             # Architecture notes & API reference
 └── README.md
```

## Quick Start

1. Copy `service/.env.example` to `.env` and set values:
   - `MONGO_URI`, `MONGO_DB_NAME`
   - `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`
   - Optionally update `SESSION_TTL_MINUTES`, `CORS_ORIGINS`
2. Install dependencies & build:

   ```bash
   cd service
   npm install
   npm run build
   npm start
   ```

3. (Optional) Run with Docker:

   ```bash
    docker compose -f service/infra/docker-compose.local.yaml up --build
   ```

The service listens on `PORT` (default `7305`). Health check at `GET /health`.

## API Summary

- `POST /v1/tenants/:tenantId/sessions` – validate tenant, persist session, issue JWT.
- `PATCH /v1/sessions/:sessionId` – attach contact identifiers or cookie context.
- See `docs/api.md` for full payloads and responses.

## SDK Usage

```ts
import { CoreAuthClient } from '@core-auth/sdk';

const client = new CoreAuthClient({
  baseUrl: 'https://auth.example.com',
  defaultTenantId: 'tenant-123'
});

const session = await client.createSession({ visitorId: 'visitor-001' });
await client.updateSession({ sessionId: session.sessionId, contactId: 'contact-42' });
```

Run `npm install && npm run build` inside `sdk/` to compile distributable assets. Consumers need a `fetch` implementation (Node 18+ or polyfill).

## Docs

- `docs/architecture.md` – design and tenancy model.
- `docs/api.md` – endpoint contract.

## Migration Notes

Existing authentication logic in `product-chatbot` maps directly onto this service:

- `packages/authorizer-core` → `service/src/core`
- `services/authorizer` → `service/src/server.ts` and routes/models

Downstream products should replace direct module imports with API calls through the service or the SDK to decouple authentication concerns.
