---
title: "RQ-0014 — Console users directory (data-first list + detail drawer)"
status: proposed
last_updated: 2026-07-03
owners: [architect]
related:
  - docs/product/RQ-0009-console-api-parity.md
  - docs/product/RQ-0010-console-ux-polish.md
  - docs/product/RQ-0011-federated-user-identity-view.md
  - docs/product/RQ-0013-invite-only-registration.md
  - docs/design/decisions/0014-console-list-detail-interaction-model.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
maestro:
  feature: console-users-directory
  kind: functional_spec
  summary: |
    Replace the console's form-first /users page — four stacked "act by email across any tenant" forms
    with no user list — with a data-first directory: pick a tenant, search/filter its users in a table
    with status badges, and act on a user from its own detail drawer (reset password, disable/enable,
    unlock, delete, link/unlink identity). Adopts the list -> search -> detail-drawer interaction model
    Auth0's management dashboard uses. Console-only: reuses the existing per-tenant
    GET /admin/v1/tenants/:id/users read and the existing user server actions; no service or SDK change.
---

# RQ-0014 — Console users directory

- **Status:** proposed
- **Raised:** 2026-07-03
- **Owner:** @farid (architect)
- **Decision:** [ADR-0014](../design/decisions/0014-console-list-detail-interaction-model.md) — the
  list -> detail-drawer interaction model and the tenant-scoped (not global-index) users read.

## Why

The console's top-level `/users` page (`console/app/users/page.tsx`) is **form-first**: four stacked
cards — *Create user*, *Reset password*, *Set status*, *Unlock* — each a form that acts *"by email
across any tenant"*. There is **no list of users on it at all**. An operator who wants to disable a
locked account must already know the email, retype it into the right form, and pick the tenant from a
dropdown — with no confirmation that the account exists, is in that tenant, or is actually locked. The
full, actionable user list only exists buried inside each tenant's detail page.

This inverts the normal operator loop. The management task almost always starts from *"which user?"* —
you search, you find, you act — not from *"I already know the exact email and the operation I want."*
Every comparable identity dashboard (Auth0, Okta, Cognito) leads with a **searchable user table** and
hangs actions off the selected record. RQ-0010 polished the console's chrome; this closes the last
form-first hole, on the surface operators touch most.

The data and the operations already exist — `api.listUsers(tenantId)` returns the full record (status,
roles, `lockedUntil`, `failedAttempts`, federated `identities`), and the user mutations already ship as
audited server actions (RQ-0009 parity). What is missing is only the **presentation**: turn the read
into a directory and route the existing actions through a per-user drawer.

## Scope

1. **Tenant-scoped directory.** `/users` shows the users of one selected tenant (a tenant picker,
   default = first tenant, selection carried in `?tenantId=`). It reuses the existing
   `GET /admin/v1/tenants/:tenantId/users`. No cross-tenant "all users" index is introduced
   (ADR-0014 — the management read stays tenant-scoped; a global index is a separate, deferred read).
2. **Search + filter, client-side.** A search box matches email or subject substring; a status filter
   selects `active` / `disabled` / `locked`. `locked` is derived from `lockedUntil` in the future.
   A result count ("N of M") is shown. Filtering never refetches — it narrows the already-loaded list.
3. **Status at a glance.** Each row shows a **status badge** (active / disabled / locked), the roles as
   chips, and the sign-in method(s) (local password + any linked federated identities, RQ-0011). A
   locked account near its lockout threshold surfaces its failed-attempt count.
4. **Detail drawer with contextual actions.** Selecting a row opens a right-side drawer showing the
   user's identity summary (email, subject, tenant, roles, created/verified, lockout state, linked
   identities) and the actions that apply to it: **reset password**, **disable / enable**, **unlock**
   (only when locked), **delete**, and **link / unlink** a Google identity. Each action is the existing
   audited server action; destructive ones keep their confirm guard. Show-once material (none here today,
   but the pattern is shared) uses the existing dialog.
5. **Create user** moves onto the page as a primary action (a dialog), scoped to the selected tenant,
   replacing the standalone create form.
6. **Parity preserved (RQ-0009).** Every operation reachable on the old page (and on the tenant-detail
   users table) remains reachable, so nothing regresses; only the interaction changes. HTTP `/admin/v1`
   and MCP are untouched.

## Acceptance criteria (EARS)

- **Ubiquitous.** The `/users` page SHALL display, for the selected tenant, a table of its users with
  columns for identity (email + subject), status, roles, and sign-in method.
- **Event-driven.** When the operator selects a tenant in the picker, the system SHALL load and display
  that tenant's users and reflect the selection in the `?tenantId=` query parameter.
- **Event-driven.** When the operator types in the search box, the system SHALL narrow the visible rows
  to users whose email or subject contains the query, without issuing a new request.
- **Event-driven.** When the operator chooses a status filter, the system SHALL show only users in that
  state, where `locked` is any user whose `lockedUntil` is in the future.
- **Event-driven.** When the operator selects a user row, the system SHALL open a detail drawer for that
  user showing its identity summary and the actions applicable to its current state.
- **State-driven.** While a user is locked, the drawer SHALL offer an **Unlock** action; while a user is
  not locked, it SHALL NOT.
- **Event-driven.** When an action in the drawer succeeds, the system SHALL refresh the directory so the
  row reflects the new state (the existing `revalidatePath('/users')` on the user actions), and SHALL
  surface the result via the existing toast / show-once dialog.
- **Unwanted-behaviour.** If the selected tenant has no users, the system SHALL show an empty state that
  invites creating the first user, not a blank table.
- **Unwanted-behaviour.** If the users read fails, the system SHALL show a non-blocking error and keep
  the rest of the page usable (tenant picker, create), consistent with the console's degrade-gracefully
  posture.
- **Constraint.** The change SHALL be console-only: no new or changed `/admin/v1` endpoint, SDK method,
  or MCP tool; it consumes the existing per-tenant users read and existing user server actions.

## Out of scope

- A cross-tenant "all users" search index (would need a new management read; deferred — ADR-0014).
- Pagination / server-side search (the per-tenant lists are small; revisit when a tenant's user count
  outgrows a single client-rendered table).
- Bulk actions (multi-select), CSV export, saved views.
- The end-user-facing `<Login/>` and invite signup redesign (tracked separately; the console lands
  first per the agreed sequencing — internal surface, lowest blast radius).
