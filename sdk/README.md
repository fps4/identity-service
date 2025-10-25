# Core Auth SDK

Minimal TypeScript client for the Core Auth service. Designed for server-side or serverless environments.

## Installation

```bash
cd sdk
npm install
npm run build
```

Publish or link the generated package as needed. Consumers require a `fetch` implementation (Node.js 18+ includes one; earlier versions can install `undici` or `node-fetch`).

## Usage

```ts
import { CoreAuthClient } from '@core-auth/sdk';

const auth = new CoreAuthClient({
  baseUrl: process.env.CORE_AUTH_URL!,
  defaultTenantId: 'tenant-123'
});

const session = await auth.createSession({
  visitorId: 'visitor-001',
  subject: 'widget-user'
});

await auth.updateSession({
  sessionId: session.sessionId,
  contactId: 'contact-42',
  cookies: { marketing_consent: true }
});
```

## API

- `createSession(options)` – Wraps `POST /v1/tenants/{tenantId}/sessions`.
- `updateSession(options)` – Wraps `PATCH /v1/sessions/{sessionId}`.

Custom headers can be supplied per call (`headers` option) or globally (`defaultHeaders` when constructing the client). If you run the service behind an API gateway, pass credentials using these headers.
