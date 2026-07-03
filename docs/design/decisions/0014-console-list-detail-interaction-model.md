---
title: "0014: Console interaction model — list -> search -> detail-drawer, tenant-scoped over existing reads"
summary: "RQ-0014 replaces the console's form-first /users page with a data-first directory. Decisions: adopt the list -> search -> detail-drawer interaction model (the operator selects a record, then acts on it) as the console's default for entity management, starting with users; keep the users read TENANT-SCOPED over the existing GET /admin/v1/tenants/:id/users rather than adding a cross-tenant user index; route every mutation through the existing audited server actions unchanged, so the change is presentation-only (no /admin/v1, SDK, or MCP surface change); do search/filter client-side over the already-loaded list; and reuse the shared show-once dialog. Scoped to the console — the HTTP + MCP management planes and their per-actor audit are untouched."
status: accepted
last_updated: 2026-07-03
date: 2026-07-03
related:
  - ./0007-management-api-mcp-and-standalone-identity-service.md
  - ./0010-console-operator-authentication.md
  - ./0012-federated-identity-and-account-linking.md
  - ./0013-invite-code-gated-registration.md
  - ../../product/RQ-0014-console-users-directory.md
  - ../../product/RQ-0009-console-api-parity.md
  - ../../product/RQ-0010-console-ux-polish.md
---

## Context

The console (ADR-0007) is a thin server-side proxy over `/admin/v1`. Its screens grew action-first:
the top-level `/users` page is four stacked forms (*create*, *reset password*, *set status*, *unlock*)
that operate *"by email across any tenant"* with **no user list on the page**. The actionable list of
users exists only inside each tenant's detail page, as a dense table with every action inlined per row.

This is backwards for the operator loop, which starts from *"which user?"* — you find the record, then
act — not from *"I already know the exact email and the operation."* Acting blind by email means no
confirmation the account exists, is in the chosen tenant, or is in the state you think. RQ-0010 polished
the chrome but left this form-first hole on the console's most-used surface. RQ-0014 closes it, and this
ADR fixes the interaction model the console will reuse for entity management generally.

Two forces constrain the shape. First, **the data and mutations already exist**:
`api.listUsers(tenantId)` returns the full record (status, roles, `lockedUntil`, `failedAttempts`,
federated `identities`), and every user mutation already ships as an audited server action with
`revalidatePath('/users')` wired in (RQ-0009 parity). Second, **there is deliberately no cross-tenant
user read** — the management plane indexes users under their tenant (`/tenants/:id/users`); a global
"all users" listing is a different query with its own scaling and authorization questions.

## Decision

**1. Adopt list -> search -> detail-drawer as the console's default entity-management interaction.**
An entity screen leads with a searchable table of records with status at a glance (badges), and hangs
actions off a **detail drawer** opened from the selected row — not off standalone forms that take an id.
Users is the first screen converted; clients and invites are candidates to follow, but this ADR only
commits users (each conversion is presentation-only and independently shippable). This mirrors the
management-dashboard pattern operators already know from Auth0/Okta/Cognito, and makes "act on the wrong
record" structurally harder because the action is bound to a record you selected, not a string you typed.

**2. The users read stays tenant-scoped; we do NOT add a cross-tenant user index.** `/users` shows one
selected tenant's users (picker, default first, carried in `?tenantId=`), reusing
`GET /admin/v1/tenants/:id/users`. A global index would need a new management read (paged, filterable,
and re-examined against per-actor scoping under ADR-0010) — real work with its own ADR. Tenant-scoped
covers the operator task (you manage a product's users) without it. Cross-tenant search is recorded as a
deferred follow-up, not a silent omission. Consequence: an operator who does not know a user's tenant
must scan tenants — acceptable at current tenant counts, revisited when it is not.

**3. Mutations route through the existing audited server actions, unchanged.** The drawer renders the
same `resetPassword` / `setUserStatus` / `unlockUser` / `deleteUser` / `linkIdentity` / `unlinkIdentity`
server actions the tenant-detail page uses, via the shared `ActionForm` (pending state, toast,
show-once dialog, native-confirm on destructive actions). So the change is **presentation-only**: no new
or changed `/admin/v1` endpoint, SDK method, or MCP tool, and the per-actor audit trail (ADR-0010) is
identical to before. This is the cheapest change that fixes the UX and the easiest to review and revert.

**4. Search and filter are client-side over the already-loaded list.** The per-tenant user lists are
small; the page loads the tenant's users once (server component) and the client narrows them by
email/subject substring and by status (`locked` derived from `lockedUntil > now`). No refetch per
keystroke, no new query params beyond `tenantId`. When a tenant's user count outgrows a single rendered
table, server-side paging/search becomes a separate decision (see Consequences).

**5. Reuse the shared show-once dialog and status vocabulary.** Any show-once material stays in the
existing dialog (ADR-0013). Status is presented with a small `Badge` primitive (active / disabled /
locked / and the neutral IdP and registration tones) so the same states read the same everywhere.

## Consequences

- **Positive:** the operator's most-used surface becomes find-then-act; acting on the wrong record is
  structurally harder; nothing regresses because the actions and audit are the exact existing ones.
- **Positive:** presentation-only means a tiny, reviewable, revertible diff and zero risk to the HTTP /
  MCP planes or their consumers — the low-blast-radius first step of the console redesign.
- **Positive:** establishes one interaction model (and a `Badge` + drawer pattern) the console can apply
  to clients and invites next, retiring the remaining action-first forms incrementally.
- **Watch — tenant-scoped means no cross-tenant search.** Finding a user whose tenant is unknown means
  scanning tenants. Accepted at today's scale; the trigger to revisit is either operators asking for
  global search or tenant count growing past casual scanning — at which point a paged cross-tenant read
  is its own ADR.
- **Watch — client-side filtering assumes small lists.** A tenant with thousands of users would ship a
  large payload and render slowly. The boundary is a tenant outgrowing a single client-rendered table;
  crossing it moves search/paging server-side (new query params, possibly a new read) — a separate
  decision, flagged here so it is not discovered in production.
- **Refines** RQ-0010 (console UX/IA) by fixing the last form-first screen, and **reuses** ADR-0007's
  proxy model, ADR-0010's per-actor actions, ADR-0012's identity linking, and ADR-0013's show-once
  dialog without altering any of them.
