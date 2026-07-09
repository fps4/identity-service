---
title: "0019: Per-application user entitlements and application-scoped roles"
summary: "Reintroduce a user↔application relationship (without Tenant): each OAuth client owns a role catalogue, and a user must hold an active assignment (entitlement + app-scoped roles) to be issued a token for that client. Enforcement is global (every user grant is gated); role catalogues are seed-bootstrapped and runtime-editable; the deployment-wide user.roles is removed and folded into app assignments (reworking ADR-0010); invites carry an app + roles (reworking ADR-0013)."
status: accepted
last_updated: 2026-07-09
date: 2026-07-09
related:
  - ./0018-collapse-tenant-into-deployment.md
  - ./0010-console-operator-authentication.md
  - ./0013-invite-code-gated-registration.md
  - ./0005-decentralized-authorization.md
---

> **Reworked by [ADR-0020](0020-application-aggregate.md) (2026-07-09):** the role catalogue, audience, and
> assignments/invites move off the OAuth **client** and up to a first-class **Application**; a client becomes
> a typed **credential** under an application, and assignments/invites re-key from `clientId` to
> `applicationId`. The entitlement gate is unchanged in spirit — it now resolves credential → application and
> requires an active assignment for `(user, application)`.

## Context

[ADR-0018](0018-collapse-tenant-into-deployment.md) collapsed Tenant into Deployment: one realm, one
shared user pool, and — deliberately — **no user↔application relationship**. Any user could authenticate
through any client; the token was audience-bound and carried a flat, deployment-wide `user.roles` array,
and *authorization* was left entirely to the resource server (ADR-0005). That is the right default for a
single product surface, but it cannot express two things this platform now needs:

1. **Entitlement** — "user X may use application Y." Under ADR-0018 identity-service will mint a token for
   any user via any login-capable client; it cannot refuse at issuance. Several apps in this deployment
   have distinct audiences and must only be reachable by the people provisioned for them.
2. **Application-scoped roles** — roles that mean something *within one application* and are defined
   *per application* (a coach `learner` is unrelated to a maestro `operator`). The flat `user.roles`
   cannot say "these roles, but only for this app."

This does **not** bring back Tenant. The realm stays single and the user pool stays shared; we add an
explicit, per-application **assignment** on top of it — the Okta "assign a user to an application, with
that application's roles" shape, layered on one realm.

## Decision

**1. Applications own a role catalogue.** Each OAuth client gains `roles: [{ key, name?, description? }]`
— the set of roles that exist *for that application*. `key` is the stable token value; `name`/
`description` are for the console. A client with no catalogue simply has no app-roles. **Both** provision
paths are supported (per the decision): catalogues can be declared in seed config (GitOps baseline) **and**
created/edited at runtime through the management plane (console / `/admin/v1` / MCP). Role definitions are
therefore semi-structural — seed bootstraps them, operators evolve them; the live DB is authoritative
(ADR-0008).

**2. A user needs an active assignment to get a token — globally.** A new `assignments` collection holds
one record per `(userId, clientId)`:

| field | meaning |
|---|---|
| `userId` | the user record `_id` (resolved regardless of local/federated login) |
| `clientId` | the application |
| `roles` | app-scoped roles granted to this user — a subset of the client's catalogue |
| `status` | `active` \| `suspended` |
| `createdBy`, timestamps | audit trail |

Unique on `{userId, clientId}`. **Every user grant is gated** (`password`, `authorization_code`, and
`refresh`): after the user authenticates, issuance requires an `active` assignment for the client, else
`access_denied` ("user is not assigned to this application"). This is a hard, global gate — there is no
per-app opt-out — so entitlement is a property every application relies on. The token's `roles` claim is
sourced from `assignment.roles` (app-scoped), and refresh re-reads it so a revoked/suspended assignment
kills further tokens (the same guarantee `assertUserActive` gives for disabled users). Client-credentials
(machine) tokens are **unaffected** — they have no user, so assignments do not apply.

**3. The deployment-wide `user.roles` is removed and folded into app assignments.** There is no longer a
global role on the user record; roles exist only per-application via assignments. **This reworks
ADR-0010:** the console operator is no longer a user carrying a global `platform_admin` role — instead
`platform_admin` is a role in the **`identity-console`** application's catalogue, and the operator holds an
assignment granting it. The management plane is unchanged in mechanism — it still reads the token's `roles`
claim and matches `ADMIN_OPERATOR_ROLES` — only the *source* of that claim moves from `user.roles` to the
identity-console assignment. Machine admin tokens (client-credentials with `scope: admin`) are unchanged.

**4. Assignments are created by operators, and by invites.** The primary path is the management plane
(console / `/admin/v1` / MCP): assign a user to an app with roles, suspend, or revoke. **This reworks
ADR-0013:** an invite now pins a target `clientId` + `roles`; redeeming it provisions the user (if new)
**and** creates the assignment, so self-service onboarding lands a person directly into one application
with the intended roles. Bare `POST /v1/register` still creates the identity, but with global enforcement
an account with no assignment can obtain no token until one is granted — registration establishes *who*,
assignment establishes *what they may reach*.

## Consequences

- **Positive — entitlement is now expressible and enforced at the source.** identity-service can refuse to
  mint a token for a user who was never provisioned for an app, instead of relying on every resource
  server to reject it. Combined with the audience binding from ADR-0018, an app is reachable only by its
  assigned users.
- **Positive — roles are meaningful per application** and defined where the application lives, without a
  Tenant layer. ADR-0005's "identity-service stamps, resource server enforces" contract is unchanged — the
  `roles` claim is just now app-scoped and entitlement-gated.
- **Trade-off — a login now has a second failure mode** ("authenticated but not assigned"). This is the
  point of the feature, but it means onboarding a user is two steps (account + assignment) unless an invite
  bundles them — which is why invites carry the app+roles.
- **Reworks ADR-0010 and ADR-0013**, as above; both keep their mechanisms, with roles/onboarding re-sourced
  through assignments. Does **not** reverse ADR-0018 — the realm and user pool stay single and shared.
- **Breaking:** the `user.roles` field, the flat-role seed/`manage-users set-roles` surface, and any token
  consumer reading `roles` as deployment-wide semantics all change. `roles` now means "this user's roles
  *in the audience's application*."
- **Watch — enforcement is global with no bypass.** Every login-capable app must have its intended users
  assigned before they can log in; a forgotten assignment is a locked-out user. The migration backfills
  existing access so nothing breaks on cutover, and the console must make "who is assigned to this app"
  and "what apps is this user in" first-class views.

## Migration

Runs against ds1 after the enforcing image deploys (idempotent; `--dry-run` first). Because enforcement is
global, existing users would be locked out unless their current access is preserved — so the migration
**backfills assignments from token history**:

1. **Build role catalogues.** For each client, seed its `roles` catalogue from the union of the (old flat)
   `user.roles` across the users who have tokens for it, plus any seed-declared roles.
2. **Backfill assignments.** For each distinct `(user, clientId)` pair observed in `oauth_tokens` (user
   grants only), create an `active` assignment whose `roles` are that user's old flat `roles` intersected
   with the client's catalogue. This keeps every currently-working login working.
3. **Seed the operator assignment.** Ensure the bootstrap operator holds `platform_admin` on
   `identity-console` (folding ADR-0010).
4. **Drop `user.roles`** from every user document once assignments are populated.

New env/config: none required beyond the existing management plane; `ADMIN_OPERATOR_ROLES` still governs
which app-role on identity-console is treated as operator. Follow-up: extend the console with an app
role-catalogue editor, an app "members" view, and a user "assignments" view; extend seed with an
`assignments`/per-user `roles-by-app` block; add MCP assignment tools.
