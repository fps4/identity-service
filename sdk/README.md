# identity-service SDK

Minimal TypeScript client for identity-service. Works server-side (Node 18+) and in the browser —
the Google-login helpers use Web Crypto (PKCE) and the token calls are plain `fetch`.

## Installation

```bash
cd sdk
npm install
npm run build
```

Publish or link the generated package as needed. Consumers require a `fetch` implementation (Node.js 18+ includes one; earlier versions can install `undici` or `node-fetch`).

## Usage

```ts
import { ComponentAuthClient } from '@fps4/identity-service-sdk';

const auth = new ComponentAuthClient({
  baseUrl: process.env.CORE_AUTH_URL!,
  defaultTenantId: 'tenant-123',
  defaultClientId: process.env.CORE_AUTH_CLIENT_ID,
  defaultClientSecret: process.env.CORE_AUTH_CLIENT_SECRET
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

const { accessToken } = await auth.requestClientCredentialsToken({
  scope: ['telemetry:write']
});
console.log(accessToken);
```

## Self-service signup (invite-aware, RQ-0013)

Register a local email/password user, then log in with the `password` grant. On a tenant whose
registration policy is `invite`, pass the operator-issued code (typically read from the signup
link's `?invite=` parameter):

```ts
await auth.registerWithPassword({
  email: 'new@acme.com',
  password: 'at-least-10-chars',
  inviteCode: new URLSearchParams(location.search).get('invite') ?? undefined
});
const token = await auth.loginWithPassword({ username: 'new@acme.com', password: '…' });
```

Failure codes to surface in the signup form: `invite_required` (the tenant is invite-only and no
code was given), `invalid_invite` (unknown / expired / revoked / exhausted / wrong email — the
server deliberately does not say which), `registration_closed`, `email_taken`, `weak_password`.

## API

User authentication:

- `registerWithPassword(options)` – `POST /v1/tenants/{tenantId}/register` (self-service signup; optional `inviteCode`, RQ-0013).
- `loginWithPassword(options)` – `POST /oauth2/token` (`password` grant, RQ-0002).
- `beginGoogleLogin(options)` / `completeGoogleLogin(options)` – Google SSO with PKCE (RQ-0001).
- `refreshUserToken(options)` – `POST /oauth2/token` (`refresh_token` grant, rotating).
- `revokeUserToken(options)` – `POST /oauth2/revoke` (RFC 7009; kills the session).

Machine + legacy:

- `requestClientCredentialsToken(options)` – `POST /oauth2/token` (client credentials grant).
- `createSession(options)` – Wraps `POST /v1/tenants/{tenantId}/sessions` (legacy, in migration).
- `updateSession(options)` – Wraps `PATCH /v1/sessions/{sessionId}` (legacy, in migration).

Custom headers can be supplied per call (`headers` option) or globally (`defaultHeaders` when constructing the client). If you run the service behind an API gateway, pass credentials using these headers.

## Publishing (maintainers)

Published to **GitHub Packages** (`npm.pkg.github.com`, `fps4` org) by the `publish-sdk` workflow. To
cut a release: bump `version` in `sdk/package.json`, merge to `main`, then push a matching tag:

```bash
git tag sdk-v0.1.0 && git push origin sdk-v0.1.0
```

The workflow verifies the tag matches `package.json`, builds, and publishes (a fresh `dist/` is rebuilt
by `prepublishOnly`), authenticating with the workflow's built-in `GITHUB_TOKEN` (`packages: write`) —
GitHub Packages' npm registry rejects fine-grained PATs. A manual `workflow_dispatch` (with an optional
dry-run) is also available. Consumers install with an `.npmrc` mapping `@fps4` to
`https://npm.pkg.github.com` and a token with `read:packages`.
