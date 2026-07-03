# @fps4/identity-service-react

Optional React UI for [identity-service](../README.md) — a drop-in `<Login/>` for consumer apps
(RQ-0003 / [ADR-0002](../docs/design/decisions/0002-optional-react-ui-package.md)).

This package is **separate from the headless `@fps4/identity-service-sdk` SDK** on purpose: server-side
consumers (e.g. the client-credentials grant) never pull in React. It depends only on React (peer);
it talks to identity-service's HTTP API directly.

## Install

```bash
npm install @fps4/identity-service-react react
```

## Usage

```tsx
import { Login } from '@fps4/identity-service-react';

export function LoginPage() {
  return (
    <Login
      baseUrl="https://auth-dev.example.com"
      clientId="client-local"            // an OAuth client allowing the `password` grant + an audience
      onSuccess={(token) => {
        // Store + use the token; route guarding is the host app's concern.
        sessionStorage.setItem('access_token', token.accessToken);
        sessionStorage.setItem('refresh_token', token.refreshToken);
      }}
      onError={(err) => console.error(err)}
    />
  );
}
```

The component renders a minimal email/password form, performs the `password` grant, and hands the
issued token (`accessToken` + `refreshToken` + …) to `onSuccess`. **Token storage, route guarding,
and refresh are intentionally the host app's responsibility** — this is a login form, not a session
manager.

> Requires a tenant with the **local IdP** enabled (`oauth.idp.provider: 'local'` + the `password`
> grant) and a client with an `audience`. See [tenant-config](../docs/guides/tenant-config.md).

## Continue with Google (RQ-0012)

Pass `google` to render a "Continue with Google" button alongside (or instead of) the password form.
Google is a **redirect** flow, so the host app owns one callback route; the button stashes the PKCE
verifier and the callback completes the exchange:

```tsx
// login page
<Login
  baseUrl={baseUrl}
  clientId="coach-web"                         // client allowing `authorization_code` + an audience
  google={{ redirectUri: 'https://app.example.com/auth/callback' }}
  hidePasswordForm                             // optional: Google-only
  onSuccess={onSuccess}
/>

// app/auth/callback/page.tsx (the registered redirect_uri)
import { completeGoogleLoginFromRedirect } from '@fps4/identity-service-react';
const token = await completeGoogleLoginFromRedirect({
  baseUrl, clientId: 'coach-web', redirectUri: 'https://app.example.com/auth/callback',
});
// store token.accessToken, then navigate into the app
```

> Requires the client to allow the **`authorization_code`** grant with the `redirectUri` registered,
> the tenant's Google IdP configured, and the deployment's Google app env set. See
> [tenant-config](../docs/guides/tenant-config.md) and [RQ-0012](../docs/product/RQ-0012-react-google-login.md).

## Signup with `<Register/>` (RQ-0015)

`<Register/>` is the signup counterpart to `<Login/>` — same prop shape, same `classNames` / `unstyled`
styling contract. It posts a local-credential registration and hands the created user to `onSuccess`.
It does **not** log the user in (that stays a separate step, like the SDK); compose it with `<Login/>`.

```tsx
import { Register } from '@fps4/identity-service-react';

<Register
  baseUrl="https://auth-dev.example.com"
  tenantId="tenant-local"
  onSuccess={(user) => {
    // user = { id, email, tenantId }. Now log them in — render <Login/> or call loginWithPassword.
    router.push('/login?registered=1');
  }}
  onError={(err) => console.error(err)}
/>
```

### Invite-only tenants

On a tenant whose registration policy is `invite` (RQ-0013), the operator sends the invitee a code (or
a link carrying it). Pass `invite` to collect it — prefill from a `?invite=` link so the invitee types
nothing:

```tsx
// app/signup/page.tsx — reached via https://app.example.com/signup?invite=V7QK-3MHP-XA2D
const invite = new URLSearchParams(window.location.search).get('invite') ?? undefined;

<Register
  baseUrl={baseUrl}
  tenantId="tenant-local"
  invite={{ required: true, defaultCode: invite, hint: 'Sent to you by your workspace admin.' }}
  onSuccess={onSuccess}
/>
```

`invite={true}` shows an optional field; the options form requires/prefills/annotates it. Even without
`invite`, an `invite_required` response **auto-reveals** the field. The component maps the server's
deliberately generic codes — `invite_required`, `invalid_invite`, `registration_closed` — to short
messages that never reveal *why* a code failed (RQ-0013 §5). On invite-only tenants a **new** user's
first "Continue with Google" is denied (`error=access_denied` on the callback) — route new users here
first; their Google account links automatically on the next login once the verified email matches (see
[tenant-config](../docs/guides/tenant-config.md)).

> Prefer to build your own form? `requestRegistration({ baseUrl, tenantId, email, password, inviteCode? })`
> is the underlying fetch-only call (or use the SDK's `registerWithPassword` on the server).

## Styling

Works unstyled-but-usable out of the box (neutral inline styles). For Tailwind / shadcn / any design
system, pass `classNames` per element and `unstyled` to drop the inline defaults:

```tsx
<Login
  baseUrl={baseUrl}
  clientId="client-local"
  unstyled
  classNames={{ form: 'space-y-4', input: 'input', button: 'btn btn-primary', error: 'text-red-600' }}
  onSuccess={onSuccess}
/>
```

## API

- `<Login baseUrl clientId onSuccess [onError title submitLabel emailLabel passwordLabel className classNames unstyled fetchImpl google hidePasswordForm] />`
- `<Register baseUrl tenantId onSuccess [onError title submitLabel emailLabel passwordLabel invite className classNames unstyled fetchImpl] />` — the signup counterpart (RQ-0015); `invite` is `true` or `{ required, defaultCode, label, hint }`.
- `requestPasswordToken({ baseUrl, clientId, username, password, fetchImpl? })` — the underlying call, for custom UIs.
- `requestRegistration({ baseUrl, tenantId, email, password, inviteCode?, fetchImpl? })` — the underlying signup call, for custom UIs.
- `RegisterError` — thrown on a rejected registration (carries `status` and the server `code`).
- `beginGoogleLogin(req)` / `completeGoogleLogin(req)` — pure helpers (build authorize URL + PKCE / exchange code).
- `startGoogleLoginRedirect(req)` / `completeGoogleLoginFromRedirect(req)` — turnkey redirect helpers (stash + navigate / read URL + validate state + exchange), used by the `<Login/>` button.
- `LoginError` — thrown on a rejected login (carries `status`).
