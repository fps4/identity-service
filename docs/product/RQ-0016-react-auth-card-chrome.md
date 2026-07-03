---
title: "RQ-0016 — Opt-in Auth0-style card chrome for <Login/> and <Register/>"
status: proposed
last_updated: 2026-07-03
owners: [architect]
related:
  - docs/product/RQ-0003-react-login-component.md
  - docs/product/RQ-0015-react-register-component.md
  - docs/design/decisions/0016-react-auth-card-opt-in-chrome.md
  - docs/design/decisions/0015-react-register-drop-in.md
  - docs/design/decisions/0002-optional-react-ui-package.md
maestro:
  feature: react-auth-card-chrome
  kind: functional_spec
  summary: |
    Give @fps4/identity-service-react's <Login/> and <Register/> an opt-in `card` prop that wraps the
    form in centered, Auth0-Universal-Login-style chrome — a brand header (logo/title/subtitle), an
    elevated card, an optional footer link, on a full-viewport page. Off by default (rendered output
    unchanged), so no existing consumer is affected. Composes with every existing prop (google,
    hidePasswordForm, invite, classNames/unstyled). Page chrome only — field styling is untouched.
---

# RQ-0016 — Opt-in card chrome for `<Login/>` / `<Register/>`

- **Status:** proposed
- **Raised:** 2026-07-03
- **Owner:** @farid (architect)
- **Decision:** [ADR-0016](../design/decisions/0016-react-auth-card-opt-in-chrome.md) — the opt-in
  `card` prop, shared shell, and default-off backward-compatibility.

## Why

`<Login/>` (RQ-0003) and `<Register/>` (RQ-0015) render a bare, neutral form — deliberately, so a host
can drop them anywhere and style them. But most consumers then rebuild the *same* wrapper by hand: a
centered, elevated card with a logo and a title — the Auth0/Okta "Universal Login" shape that the
console prototype (`docs/design/prototypes/console-auth0-ux.html`) modelled and that motivated this
whole initiative. ADR-0015 left that chrome host-owned; in practice it is boilerplate every consumer
writes identically.

An **opt-in** `card` prop gives consumers the batteries-included look in one line, while leaving the
bare-form default untouched for those who want it (or who compose their own chrome / use `unstyled` +
`classNames`). It is the smallest change that delivers the "adopt Auth0 views" goal in the published
package without imposing an opinion on anyone who didn't ask for it.

## Scope

1. **A `card` prop** on both `<Login/>` and `<Register/>`: `card?: boolean | CardOptions`.
   - `card={true}` → centered card with sensible defaults;
   - `card={{ logo, subtitle, footer, width, fullViewport }}` → a brand mark (any node), a muted
     subtitle under the title, a footer slot (e.g. a "Sign up" / "Log in" link), a card width, and a
     toggle for the full-viewport page background.
2. **Default off.** With no `card`, the components render exactly as before — a bare `<form>` with the
   title as an `<h2>` — so no existing consumer's output changes.
3. **In card mode:** the `title` moves into the card header as an `<h1>`, the form fills the card, and
   the primary button goes full-width — the expected card layout.
4. **Composition.** `card` wraps whatever the component already renders, so it works together with
   `google` / `hidePasswordForm` (Login) and `invite` (Register), and with `className` / `classNames`.
5. **A shared `AuthCard` shell** backs both components (and is exported) so the two screens are visually
   identical and a host can reuse the shell for its own auth-adjacent pages.
6. **Scope boundary:** the card styles the *page/card chrome*; individual field styling still follows
   `classNames` / `unstyled` exactly as today.

## Acceptance criteria (EARS)

- **Ubiquitous.** With no `card` prop, `<Login/>` and `<Register/>` SHALL render the identical markup
  they render today (a bare `<form>` with an `<h2>` title) — a regression guard, covered by a test.
- **State-driven.** While `card` is set, the component SHALL wrap the form in a centered card, render
  the title as an `<h1>` in the card header (not a duplicated `<h2>` in the form), and render the
  primary button full-width.
- **Event-driven.** When `card.logo`, `card.subtitle`, or `card.footer` are provided, the card SHALL
  render them in the header (logo, subtitle) and below the form (footer) respectively.
- **State-driven.** While `card.fullViewport` is `false`, the component SHALL render the card without
  the full-viewport page wrapper (for embedding in an existing layout).
- **Constraint.** `card` SHALL compose with `google` / `hidePasswordForm` / `invite` — the card wraps
  the form those props already produce, adding no new network behaviour.
- **Constraint.** The card SHALL add no dependency to the shipped package beyond React (peer); its
  render test may use `react-dom/server` as a dev-only dependency.

## Out of scope

- A full theming/design-token system, dark mode, or CSS-variable theming (consumers who need that use
  `unstyled` + `classNames`, or the exported `AuthCard` shell directly).
- Social-button iconography beyond the existing Google button.
- Multi-step / wizard layouts.
