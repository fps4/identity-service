---
title: "RQ-0017 — Console applications & invites directories (list + detail drawer)"
status: proposed
last_updated: 2026-07-03
owners: [architect]
related:
  - docs/product/RQ-0014-console-users-directory.md
  - docs/product/RQ-0009-console-api-parity.md
  - docs/product/RQ-0013-invite-only-registration.md
  - docs/design/decisions/0014-console-list-detail-interaction-model.md
  - docs/design/decisions/0013-invite-code-gated-registration.md
maestro:
  feature: console-clients-invites-directory
  kind: functional_spec
  summary: |
    Apply the list -> search -> detail-drawer model (ADR-0014, shipped for users in RQ-0014) to the
    console's two remaining form-first surfaces. Applications (OAuth clients): a tenant-scoped searchable
    table with type badges and a per-application drawer (rotate secret — confidential only — and delete),
    replacing the page that needed a hand-typed ?tenantId= to list anything. Invites: a NEW top-level,
    tenant-scoped directory with status badges and a per-invite drawer (revoke), giving invites a
    first-class home (they were only reachable inside a tenant's detail page). Both reuse the existing
    per-tenant reads and audited server actions; no service/SDK/MCP change.
---

# RQ-0017 — Console applications & invites directories

- **Status:** proposed
- **Raised:** 2026-07-03
- **Owner:** @farid (architect)
- **Decision:** [ADR-0014](../design/decisions/0014-console-list-detail-interaction-model.md) — the
  list → detail-drawer interaction model and the tenant-scoped reads. This RQ applies it to clients and
  invites, the follow-ups ADR-0014 anticipated.

## Why

RQ-0014 converted the console's Users page to a data-first directory and ADR-0014 set that as the
model, naming **clients and invites** as the surfaces to follow. They are the two that still invert the
operator loop:

- **Applications (clients)** — the `/clients` page is form-first and, worse, its list is gated behind a
  **hand-typed `?tenantId=` URL**: with no query param it shows no clients at all. "Rotate a secret" is a
  form you paste a client id into, detached from the client it belongs to.
- **Invites** — there is **no top-level invites surface**. Invites (RQ-0013) are reachable only by
  drilling into a specific tenant's detail page, so an operator cannot answer "what invites are
  outstanding for this product?" without knowing where to look.

Both already have the data (`listClients`, `listInvites`) and audited mutations (create / rotate /
delete; create / revoke). This RQ supplies the missing presentation: the same tenant-scoped
directory + detail-drawer users got, so all three entity screens read and behave alike.

## Scope

1. **Applications directory** (`/clients`): tenant picker (default first, `?tenantId=`), client-side
   search (name / client id), a table with a **type badge** (Confidential / Public·PKCE), grants and
   scopes, and a per-application **detail drawer**. Drawer actions: **rotate secret** (confidential
   clients only — public clients have no secret) and **delete**, via the existing actions; the new
   secret uses the show-once dialog. "Register application" is a create dialog scoped to the tenant.
2. **Invites directory** (`/invites`, new route + nav entry): tenant picker, search (email / note),
   **status filter** (pending / redeemed / expired / revoked), a table with **status badges**, and a
   per-invite **detail drawer** (binding, roles, uses, expiry, note). Drawer action: **revoke** (pending
   invites only). "Create invite" is a dialog whose show-once code uses the shared dialog (ADR-0013).
3. **A shared `Drawer` primitive** backs the applications and invites drawers (and matches the users
   drawer), so every entity detail view reads the same.
4. **Parity preserved (RQ-0009).** Every operation reachable before (on the old `/clients` page and in
   tenant detail) remains reachable; only the interaction changes. HTTP `/admin/v1` and MCP untouched.

## Acceptance criteria (EARS)

- **Ubiquitous.** `/clients` SHALL display, for the selected tenant, a searchable table of its OAuth
  clients with a type badge, and `/invites` SHALL display that tenant's invites with a status badge.
- **Event-driven.** When the operator selects a tenant, each page SHALL load that tenant's records and
  reflect the selection in `?tenantId=`.
- **Event-driven.** When the operator selects a row, the system SHALL open a detail drawer for that
  record with the actions applicable to its state.
- **State-driven.** While a client is confidential, its drawer SHALL offer **Rotate secret**; while it
  is public/PKCE, it SHALL NOT. While an invite is pending, its drawer SHALL offer **Revoke**; otherwise
  it SHALL NOT.
- **Event-driven.** When a mutation succeeds, the system SHALL refresh the directory (the actions'
  `revalidatePath('/clients')` / `revalidatePath('/invites')`) and surface the result via the existing
  toast / show-once dialog.
- **Unwanted-behaviour.** If a tenant has no clients (or no invites), the page SHALL show an empty state
  that invites creating the first one, not a blank table; a failed read SHALL degrade gracefully.
- **Constraint.** The change SHALL be console-only: no new or changed `/admin/v1` endpoint, SDK method,
  or MCP tool.

## Out of scope

- Cross-tenant client/invite search (would need a new management read — same deferral as ADR-0014).
- Pagination / server-side search; bulk actions.
- Converting the in-tenant-detail clients/users/invites tables (they can adopt the drawer later; this RQ
  lands the top-level directories operators start from).
