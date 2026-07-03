---
title: "0016: Opt-in card chrome for <Login/>/<Register/> — a `card` prop, default off, shared shell"
summary: "RQ-0016 gives the React drop-ins an Auth0-Universal-Login look without imposing it. Decisions: add a `card?: boolean | CardOptions` prop to <Login/> and <Register/> that wraps the form in a shared AuthCard shell (brand header + elevated card + optional footer + full-viewport page), rather than a separate <AuthLayout> the host must assemble or a breaking restyle of the bare form; keep it OFF by default so existing consumers' rendered output is byte-identical (guarded by a render test); in card mode move the title into the card header as <h1>, fill the card, and go full-width, while field styling still follows classNames/unstyled; export the AuthCard shell for reuse; and add react-dom only as a dev dependency for the one render test. This revisits ADR-0015's 'card chrome stays host-owned' now that it is opt-in and additive, not imposed."
status: accepted
last_updated: 2026-07-03
date: 2026-07-03
related:
  - ./0015-react-register-drop-in.md
  - ./0002-optional-react-ui-package.md
  - ../../product/RQ-0016-react-auth-card-chrome.md
  - ../../product/RQ-0003-react-login-component.md
  - ../../product/RQ-0015-react-register-component.md
---

## Context

`<Login/>` and `<Register/>` render a bare, neutral form on purpose (ADR-0002): a host can drop them in
and style them however it likes. ADR-0015 explicitly left card/branding chrome host-owned. But the
"adopt Auth0 Universal Login" goal that drove this initiative wants exactly that chrome — a centered,
elevated card with a brand header — and in practice every consumer rebuilds the same wrapper by hand.
The console prototype (`docs/design/prototypes/console-auth0-ux.html`) is the reference look. The
question is how to offer it without breaking the deliberately-minimal default or imposing an opinion.

## Decision

**1. A `card` prop on both components, backed by a shared `AuthCard` shell — not a separate layout
component, and not a restyle of the bare form.** `card?: boolean | CardOptions`. A separate
`<AuthLayout>` the host wraps around the form would just move the boilerplate, not remove it, and would
let the two screens drift; restyling the bare form itself would break every existing consumer. A prop
that wraps the component's own output keeps one call site, guarantees Login and Register match (same
shell), and composes with every existing prop (`google`, `hidePasswordForm`, `invite`, `classNames`).

**2. Off by default — the bare-form output stays byte-identical.** With no `card`, the components
render exactly as before (a `<form>` with an `<h2>` title). This is the backward-compatibility contract
and it is enforced by a render test asserting the card-off markup is unchanged. Adopting the card is a
one-line, opt-in choice; nobody who didn't ask for it is affected. This is why the change ships as a
**minor** bump, not a major.

**3. In card mode the layout follows the card, not the form.** The `title` moves into the card header
as an `<h1>` (so it isn't duplicated as the form's `<h2>`), the form fills the card width, and the
primary button goes full-width — the layout a card implies. `CardOptions` covers the parts consumers
actually vary: `logo` (any node), `subtitle`, `footer` (e.g. the cross-link between login and signup),
`width`, and `fullViewport` (drop the page background to embed in an existing layout). Field-level
styling still follows `classNames` / `unstyled` — the card governs page chrome only, a clean seam.

**4. Export the `AuthCard` shell.** A host building an auth-adjacent page (a "check your email" step, an
error page) can reuse the exact shell for visual consistency, instead of re-deriving it. Exporting it
also makes the seam explicit: the card is a plain wrapper, not magic inside the form.

**5. `react-dom` is a dev-only dependency, for the one render test.** The card is pure rendering, so it
warrants a render test — the first in this package. `react-dom/server`'s `renderToStaticMarkup` needs no
jsdom and stays a `devDependency`; the shipped package still depends only on React (peer). This nuances
ADR-0015's "no render test" note: the earlier change had no rendering worth asserting, this one does.

**6. Style values are inline in the shell, duplicated from the components' palette.** Consistent with
ADR-0015's choice to duplicate rather than introduce a shared token layer; a real design-token system
is out of scope (RQ-0016) and remains the escape hatch (`unstyled` + `classNames`).

## Consequences

- **Positive:** consumers get the Auth0 look in one line; Login and Register are guaranteed to match;
  the bare-form default (and every existing consumer) is untouched, proven by the card-off render test.
- **Positive:** `card` composes with Google, invite, and class-based styling, so it needs no per-feature
  variants; the exported shell lets hosts extend the look to adjacent pages.
- **Positive:** the package gains a real render-test capability (`react-dom/server`) at zero cost to the
  shipped dependency surface.
- **Watch — this is opinionated chrome in a library.** The inline card styles are a fixed look; teams
  with a design system should use `unstyled` + `classNames` or the shell, not fight the card. If demand
  for theming grows, that is the trigger for the design-token layer ADR-0015/0016 both defer.
- **Watch — duplicated style values now span three files** (Login, Register, AuthCard). A visual refresh
  must touch all three or they drift; revisit if/when tokens land.
- **Revisits** ADR-0015 (card chrome is no longer strictly host-owned — it is available opt-in) and
  **extends** ADR-0002 (the package may carry opinionated, opt-in presentation, as long as the
  unstyled/bare path stays first-class).
