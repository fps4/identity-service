# Core Auth Architecture

The **core-auth** project separates authentication responsibilities into a configurable service and lightweight clients so that multiple products can authenticate users and devices in a consistent, multi-tenant aware way.

## Components

- **Service (`service/`)** – Node.js + Express API that brokers session creation and updates. It validates tenants, persists sessions in MongoDB, and issues JWTs for downstream services.
- **SDK (`sdk/`)** – Minimal TypeScript client that wraps the HTTP endpoints with ergonomic methods for server-side or serverless use.
- **Docs (`docs/`)** – Design notes, API surface, and onboarding references for teams adopting the service.

## Request Flow

1. A widget or product backend makes a `POST /v1/tenants/{tenantId}/sessions` request to the service.
2. The service validates the tenant, creates a session record, signs a JWT, and returns session metadata.
3. The client stores the token (e.g., cookie) and uses it to authenticate subsequent calls to product APIs.
4. When additional context (contact id, cookies) becomes available, `PATCH /v1/sessions/{sessionId}` associates it with the session.

## Multi-Tenancy Model

- Tenants and sessions are stored in MongoDB collections partitioned by `tenantId`.
- Allowed CORS origins are loaded from tenant documents and refreshed periodically (configurable interval).
- JWTs embed both session (`sid`) and tenant (`tid`) identifiers, letting downstream services authorize tenant-level resources quickly.

## Deployment

- The service runs as a stateless container. Configuration is driven entirely through environment variables; see `service/.env.example`.
- MongoDB is the only stateful dependency; a sample `docker-compose` file is available in `service/infra`.
- JWT secrets remain unique per environment; rotation can be handled by redeploying with updated `AUTH_JWT_SECRET`.

## Extensibility

- Add custom tenant validation logic by extending `createAuthorizer` dependencies.
- Implement additional routes by mounting new routers inside `service/src/server.ts`.
- The SDK can be wrapped or re-exported with product-specific defaults to simplify adoption. 
