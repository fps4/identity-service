---
title: "RQ-0015 — Drop-in React <Register/> for invite-aware self-registration"
status: proposed
last_updated: 2026-07-03
owners: [architect]
related:
  - docs/product/RQ-0003-react-login-component.md
  - docs/product/RQ-0013-invite-only-registration.md
  - docs/product/RQ-0012-react-google-login.md
  - docs/design/decisions/0015-react-register-drop-in.md
  - docs/design/decisions/0002-optional-react-ui-package.md
maestro:
  feature: react-register-component
  kind: functional_spec
  summary: |
    Add a drop-in <Register/> to @fps4/identity-service-react — the signup counterpart to <Login/> —
    so consumer apps get self-service local-credential registration without hand-building the form.
    It posts to POST /v1/tenants/:tenantId/register, supports invite-only tenants (RQ-0013) with an
    invite-code field (prefill from a link, require it, or auto-reveal it when the server answers
    invite_required), maps the server's generic invite errors to user-facing copy, and hands the new
    user to onSuccess. Framework-free requestRegistration underlies it, mirroring requestPasswordToken.
    <Login/> is unchanged.
---

# RQ-0015 — Drop-in React `<Register/>`

- **Status:** proposed
- **Raised:** 2026-07-03
- **Owner:** @farid (architect)
- **Decision:** [ADR-0015](../design/decisions/0015-react-register-drop-in.md) — a drop-in `<Register/>`
  parallel to `<Login/>`, invite handling, and leaving the published `<Login/>` untouched.

## Why

`@fps4/identity-service-react` ships a drop-in `<Login/>` (RQ-0003) but **no signup surface**. RQ-0013
added invite-only self-registration across the service, SDK, and console — but a consumer building a
*React* app still has to hand-roll the signup form. Today the package README literally tells them to:
*"signup is a small form the host app owns, built on the SDK's `registerWithPassword`."* That is the
same boilerplate `<Login/>` was created to remove for the login case — the field state, the submit and
pending handling, and (now) the invite-code plumbing and the mapping of the server's deliberately
opaque `invite_required` / `invalid_invite` errors into copy a user can act on.

A drop-in `<Register/>` closes the pair. It mirrors `<Login/>`'s ergonomics exactly (same props shape,
same `classNames` / `unstyled` styling contract, same framework-free network function beneath), so a
consumer who has adopted `<Login/>` gets signup for near-zero additional effort — and the two screens
look and behave consistently, which is the point of adopting the Universal-Login pattern in the first
place.

## Scope

1. **A framework-free `requestRegistration`** (mirrors `requestPasswordToken`): posts
   `{ email, password, inviteCode? }` to `POST /v1/tenants/:tenantId/register`, returns the created
   `{ id, email, tenantId }`, and throws a `RegisterError` carrying the HTTP `status` and the server's
   error `code`. Depends only on `fetch` (overridable for tests/SSR), like the rest of the package.
2. **A drop-in `<Register/>` component** parallel to `<Login/>`:
   `baseUrl`, `tenantId`, `onSuccess(user)`, `onError?`, `title?`, `submitLabel?`, `emailLabel?`,
   `passwordLabel?`, `className?`, `classNames?`, `unstyled?`, `fetchImpl?`.
3. **Invite support (RQ-0013)** via an `invite` prop:
   - `invite={true}` renders an optional invite-code field;
   - `invite={{ required, defaultCode, label, hint }}` requires it, prefills it (e.g. from a
     `?invite=` link), and relabels/annotates it;
   - even when `invite` is omitted, an `invite_required` response **auto-reveals** the field so the
     user can recover without a code the developer forgot to wire.
4. **User-facing error mapping.** The server keeps invite failures generic on purpose (RQ-0013 §5):
   `invite_required`, `invalid_invite`, `registration_closed`, `email_taken` map to short, honest,
   non-probing messages; anything else falls back to the server message.
5. **Exports** `Register`, `requestRegistration`, `RegisterError`, and the associated types from the
   package entry; README gains a `<Register/>` section (the SDK-based hand-roll stays documented as the
   escape hatch).
6. **`<Login/>` is unchanged** — no edits to its source, styles, or API (ADR-0015): the published login
   surface carries zero regression risk from this change.

## Acceptance criteria (EARS)

- **Ubiquitous.** `<Register/>` SHALL render an email + password form and, on submit, POST a
  local-credential registration to `POST /v1/tenants/:tenantId/register` for the given `tenantId`.
- **Event-driven.** When registration succeeds, the component SHALL call `onSuccess` with the created
  `{ id, email, tenantId }` and SHALL NOT itself log the user in (login stays a separate step, matching
  the SDK split).
- **State-driven.** While `invite` is set (or an `invite_required` response has been received), the
  component SHALL render an invite-code field; when `invite.required` (or auto-required) is in effect,
  it SHALL block submission until a non-empty code is entered.
- **Event-driven.** When `invite.defaultCode` is provided, the field SHALL be prefilled with it (so a
  `?invite=` link works with no extra host code).
- **Unwanted-behaviour.** If the server rejects with `invite_required`, the component SHALL reveal the
  invite field and show "this signup needs a valid invite code"; with `invalid_invite`, it SHALL show
  an "invalid or expired" message — neither revealing why a code failed (RQ-0013 §5).
- **Constraint.** `requestRegistration` SHALL depend only on `fetch` (overridable via `fetchImpl`) and
  pull in no dependency beyond React (peer), consistent with the package's isolation from the SDK.
- **Constraint.** The change SHALL NOT modify `<Login/>`'s source, rendered output, or public API.

## Out of scope

- Logging the user in after signup (host composes `<Register/>` → `<Login/>` / `loginWithPassword`).
- A multi-step wizard, email-verification UI, or "Continue with Google" on signup (invite-only tenants
  deny Google-first new users by design — RQ-0013 §6; route them here first).
- Card/branding chrome around the form — the host owns page chrome, as with `<Login/>` (the console
  prototype at `docs/design/prototypes/console-auth0-ux.html` shows the reference card a host can copy).
