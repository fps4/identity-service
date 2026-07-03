---
title: "0015: React <Register/> as a drop-in parallel to <Login/> — invite-aware, framework-free, Login untouched"
summary: "RQ-0015 adds a signup surface to @fps4/identity-service-react. Decisions: ship a drop-in <Register/> that mirrors <Login/>'s prop shape, styling contract (classNames/unstyled), and framework-free-network design, rather than folding signup into <Login/> or leaving it to the SDK hand-roll; back it with a standalone requestRegistration mirroring requestPasswordToken (fetch-only, no SDK dependency); handle invites (RQ-0013) with one `invite` prop that renders/requires/prefills the code field and auto-reveals it on an invite_required response, mapping the server's deliberately-generic invite errors to short non-probing copy; keep register and login as separate steps (onSuccess returns the created user, it does not log in), matching the SDK split; and leave the published <Login/> byte-for-byte unchanged so it carries zero regression risk. Page/card chrome stays host-owned, as it already is for <Login/>."
status: accepted
last_updated: 2026-07-03
date: 2026-07-03
related:
  - ./0002-optional-react-ui-package.md
  - ./0013-invite-code-gated-registration.md
  - ../../product/RQ-0015-react-register-component.md
  - ../../product/RQ-0003-react-login-component.md
  - ../../product/RQ-0013-invite-only-registration.md
---

## Context

`@fps4/identity-service-react` (ADR-0002) is the optional drop-in UI: a `<Login/>` plus small
framework-free network functions (`requestPasswordToken`, the Google helpers), depending only on React
as a peer and talking to identity-service's HTTP API directly — deliberately **not** via the headless
SDK, so the two packages stay independent. It has no signup surface. RQ-0013 shipped invite-only
self-registration everywhere else (service endpoint, SDK `registerWithPassword`, console, MCP), and the
package README currently hands React consumers the boilerplate: build your own form on the SDK.

That is exactly the boilerplate `<Login/>` exists to remove — field state, submit/pending, error
surfacing — now with extra invite plumbing (reading a code from a link, requiring it, and translating
the server's intentionally opaque `invite_required` / `invalid_invite` responses into actionable copy).
RQ-0015 closes the login/signup pair. The open questions are where signup lives, how it depends on the
network, how invites surface, and what it must not disturb.

## Decision

**1. A separate drop-in `<Register/>`, not a mode of `<Login/>`.** Login and registration are different
operations with different inputs, endpoints (`/oauth2/token` vs `/v1/.../register`), outputs (a token
vs a created user), and failure modes (bad credentials vs invite gating). Overloading `<Login/>` with a
`mode` prop would bloat its API and its rendered branches. A parallel component keeps each screen
focused and lets a host route between them. It **mirrors `<Login/>` exactly** — same prop names
(`baseUrl`, `onSuccess`, `onError`, `title`, `submitLabel`, label overrides), same styling contract
(`classNames` per element + `unstyled`), same `fetchImpl` seam — so adopting it is muscle memory for a
team already using `<Login/>`, and the two screens render consistently.

**2. Back it with a standalone `requestRegistration`, mirroring `requestPasswordToken`.** The network
call is a plain, exported, fetch-only function (overridable `fetchImpl`) throwing a `RegisterError` that
carries the HTTP `status` **and** the server error `code`. This keeps the package's no-SDK, no-deps
isolation (ADR-0002), makes the call unit-testable with a fake fetch (the package's established test
style — no jsdom/component-render tests), and gives custom UIs the same escape hatch `requestPasswordToken`
gives them. We do **not** reuse the SDK's `registerWithPassword`: pulling the SDK into the React package
would break the deliberate separation that keeps server-side consumers from transitively depending on React.

**3. One `invite` prop covers the RQ-0013 cases, and the field auto-reveals on `invite_required`.**
`invite={true}` shows an optional code field; `invite={{ required, defaultCode, label, hint }}` requires
it, prefills it (so a `?invite=` link needs no host glue), or annotates it. Crucially, even when a
developer omits `invite`, an `invite_required` response flips the field visible — the user can recover
without the developer having pre-known the tenant's policy (which the client cannot read ahead of time).
This trades a tiny amount of component state for robustness against misconfiguration.

**4. Map the server's generic invite errors to short, non-probing copy.** RQ-0013 §5 makes the server
answer `invite_required` / `invalid_invite` / `registration_closed` without revealing *why* a code
failed, so codes cannot be probed. The component preserves that: it shows "needs a valid invite code" /
"invalid or expired" / "registration is closed", never a reason, and falls back to the server message
for anything else. The opacity is a security property (§5) and the UI must not leak around it.

**5. Register and login stay separate steps.** `onSuccess` returns the created `{ id, email, tenantId }`;
the component does **not** then log the user in. This matches the SDK split (`registerWithPassword` vs
`loginWithPassword`) and keeps token storage / routing the host's concern, exactly as `<Login/>` already
declares. A host composes the two (render `<Login/>`, or call the login helper) after signup.

**6. `<Login/>` is left byte-for-byte unchanged.** No edits to its source, default styles, or API. On a
**published** package the safest change is an additive one; a new component and new exports cannot
regress an existing `<Login/>` consumer. Shared style *values* are duplicated into `<Register/>` rather
than refactored out of `<Login/>`, accepting a few lines of duplication to keep the login surface's
rendered output provably identical. This ships as a **minor** version bump (new feature, no break).

## Consequences

- **Positive:** React consumers get invite-aware signup as a drop-in, consistent with `<Login/>`;
  the README's hand-roll becomes the escape hatch, not the only path.
- **Positive:** the published `<Login/>` carries zero regression risk (unchanged), and the package keeps
  its no-SDK/no-deps isolation; the new code is testable in the package's existing fake-fetch style.
- **Positive:** invite handling is robust to a host that didn't wire the policy, and it upholds the
  RQ-0013 non-enumeration property in the UI layer.
- **Watch — duplicated default styles.** `<Login/>` and `<Register/>` now hold their own copies of the
  same inline style values; a future visual refresh must touch both (or they drift). The alternative —
  refactoring shared styles out of `<Login/>` — was rejected to keep the published login output
  identical; revisit if a real design-token layer lands for the package.
- **Watch — no component-render test.** Consistent with `<Login/>`, only `requestRegistration` is unit
  tested (fake fetch); the component's invite-reveal branching is covered by review, not a jsdom test,
  because the package intentionally carries no render-test harness. Add one only if the package gains a
  jsdom/testing-library setup for other reasons.
- **Extends** ADR-0002 (the package grows a second drop-in on the same terms) and **surfaces** ADR-0013
  in React (the invite gate and its generic errors now have a first-class UI). ADR-0012's Google-first
  denial on invite-only tenants is unchanged — new users are routed here first, as RQ-0013 §6 intends.
