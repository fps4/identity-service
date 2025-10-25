# Core Auth Service

Express-based REST API for creating and updating multi-tenant sessions.

## Setup

```bash
cd service
npm install
cp .env.example .env   # update secrets & Mongo connection
npm run build
npm start
```

### Required Environment Variables

| Variable | Description |
| --- | --- |
| `MONGO_URI` | Connection string to the MongoDB host (no database appended). |
| `MONGO_DB_NAME` | Database that stores `tenants` and `sessions`. |
| `AUTH_JWT_SECRET` | Secret used to sign session JWTs (HS256). |
| `AUTH_JWT_ISSUER` | JWT issuer claim. |
| `AUTH_JWT_AUDIENCE` | JWT audience claim. |
| `SESSION_TTL_MINUTES` | Session lifetime in minutes. |

Optional:
- `CORS_ORIGINS` – comma-separated list of static origins.
- `TENANT_CORS_REFRESH_INTERVAL_MS` – refresh interval for tenant-scoped origins.
- `LOG_LEVEL`, `LOG_PRETTY` – logging configuration.

## Scripts

- `npm run dev` – Watch mode with `tsx`.
- `npm run build` – Type-check and emit JavaScript to `dist/`.
- `npm start` – Run compiled server (`dist/server.js`).

## Mongo Collections

- `tenants` – tenant metadata and allowed origins.
- `sessions` – session records, keyed by UUID.

Seed tenants by inserting documents similar to:

```js
db.tenants.insertOne({
  _id: 'tenant-123',
  name: 'Tenant Name',
  status: 'active',
  allowedOrigins: ['https://widget.example.com']
});
```

## Docker

`service/infra/docker-compose.local.yaml` spins up MongoDB and the service together for local development.
