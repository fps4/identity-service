---
title: "RQ-0013 — Invite-only self-registration (operator-issued invite codes)"
status: proposed
last_updated: 2026-07-03
owners: [architect]
related:
  - docs/product/RQ-0002-local-password-idp.md
  - docs/product/RQ-0004-seed-config-provisioning.md
  - docs/product/RQ-0009-console-api-parity.md
  - docs/design/decisions/0013-invite-code-gated-registration.md
  - docs/reference/api.md
  - docs/guides/tenant-config.md
maestro:
  feature: invite-only-registration
  kind: functional_spec
  summary: |
    Let a tenant close open self-registration behind operator-issued invite codes. An operator mints a
    code from the admin plane (console, /admin/v1, or MCP), sends it out-of-band (email, chat), and the
    invitee redeems it during the existing local-password registration. Codes are shown once, stored
    hashed, can be email-bound, single- or multi-use, expiring, and revocable; redemption can stamp
    roles and mark an email-bound invitee's address verified. No mail provider is required — the
    operator distributes codes, the service only validates them.
---

# RQ-0013 — Invite-only self-registration

- **Status:** proposed
- **Raised:** 2026-07-03
- **Owner:** @farid (architect)
- **Decision:** [ADR-0013](../design/decisions/0013-invite-code-gated-registration.md) — invite model,
  code storage, atomic redemption, and the federated-provisioning gate.

## Why

Local-password self-registration (RQ-0002) is all-or-nothing today: if a tenant enables the `password`
grant with the `local` IdP, `POST /v1/tenants/:tenantId/register` is open to anyone who can reach it.
The only abuse guard is a per-tenant registrations-per-minute cap. For closed products (an internal
tool, a coached cohort, a paid beta) the operator wants **self-service signup for invited people
only** — without pre-creating every account by hand (the current workaround) and without waiting for
the deferred email-verification channel (ADR-0001).

Invite codes fit the deployment's constraints exactly: the service has **no mail provider**, and an
invite code needs none — the operator sends it over whatever channel they already use. Two problems
shrink as side effects: the `email_taken` enumeration surface stops being publicly reachable on
invite-only tenants, and an **email-bound** invite lets registration set `emailVerified: true` — the
operator sent the code to that address, the same "a trusted party vouched for this email" logic that
gates federated auto-linking (ADR-0012).

## Scope

1. **A per-tenant registration policy** — `oauth.registration: 'open' | 'invite' | 'closed'`
   (default `open`, preserving current behaviour). Settable via seed config (RQ-0004) and the admin
   plane.
2. **Operator-issued invites** on the management plane (HTTP `/admin/v1`, MCP tools, console — parity
   per RQ-0009): create (returns the code **once**), list (status: pending / redeemed / expired /
   revoked; never the code), revoke. All three actions audited (ADR-0007).
3. **Invite options:** optional email binding, optional roles to stamp on redemption (validated
   against the tenant's `allowedRoles`), expiry (default 7 days), max uses (default 1), free-text note.
4. **Redemption** — an optional `inviteCode` on the existing `POST /v1/tenants/:tenantId/register`.
   On an `invite` tenant a valid code is required; redemption is atomic (a racing duplicate use of a
   single-use code loses), stamps the invite's roles, and — when the invite is email-bound and the
   emails match — sets `emailVerified: true`.
5. **Federated gate:** on an `invite` or `closed` tenant, a federated (Google) login that would
   JIT-provision a **new** user is denied; existing users (including linked ones) are untouched.
6. **Console UX:** an Invites card on the tenant drill-down (create form with roles/expiry/uses,
   status list, revoke), with the new code presented in a **copy-friendly show-once modal** shared
   with client-secret creation/rotation (replacing the transient toast for secrets too).
7. **SDK/React:** `registerWithPassword` accepts `inviteCode`; the React package documents a signup
   page reading `?invite=` from the URL.

## Out of scope

- **Email delivery of invites** — the operator distributes codes out-of-band. A mail provider (and
  with it invite emails, verification, password reset — ADR-0001's deferrals) is a separate RQ.
- **Invite acceptance inside the federated redirect flow** — an invitee on an invite-only tenant
  registers locally first; their Google identity then links on verified email per ADR-0012. Carrying
  an invite through the OAuth `state` is deliberately deferred.
- **Bulk/CSV invites and invite quotas** — single-code creation only; a multi-use code covers cohorts.
- **Changing the token contract or any OAuth grant** — registration-time only.

## Acceptance criteria (EARS)

- WHERE a tenant's `oauth.registration` is unset or `open`, THE SYSTEM SHALL accept registrations
  exactly as today (RQ-0002), with or without an `inviteCode`.
- WHERE `oauth.registration` is `closed`, THE SYSTEM SHALL reject registration with `403
  registration_closed`.
- WHERE `oauth.registration` is `invite`, WHEN a registration arrives without a code, THE SYSTEM
  SHALL reject it with `403 invite_required`; WHEN it arrives with a code that is unknown, expired,
  revoked, exhausted, or bound to a different email, THE SYSTEM SHALL reject it with a single generic
  `403 invalid_invite` that does not reveal which check failed.
- WHEN an operator creates an invite, THE SYSTEM SHALL return the plaintext code exactly once and
  persist only a digest; list responses SHALL never contain the code.
- WHEN an invite specifies roles, THE SYSTEM SHALL validate them against the tenant's `allowedRoles`
  vocabulary at creation time and stamp them on the redeemed user.
- WHEN two registrations race a single-use code, THE SYSTEM SHALL admit at most `maxUses` users
  (atomic redemption); a failed registration SHALL NOT consume a use.
- WHEN an email-bound invite is redeemed by the matching (normalized) email, THE SYSTEM SHALL set
  `emailVerified: true` on the created user.
- WHEN an operator revokes a pending invite, THE SYSTEM SHALL refuse subsequent redemptions of it.
- WHERE a tenant is `invite` or `closed`, WHEN a federated login would create a new user, THE SYSTEM
  SHALL deny it via the existing trusted-redirect `access_denied` path; a login by an existing user
  SHALL succeed unchanged.
- Invite create/revoke and every redemption SHALL be captured in the append-only audit log with the
  acting principal (ADR-0007).

## Definition of done

- Service: model + policy + gated registration + `/admin/v1` invite endpoints + MCP tools, with unit
  tests covering the policy matrix, atomic redemption race, email binding, expiry/revocation, roles
  stamping, and the federated new-user gate. `docs/reference/api.md` and
  `docs/guides/tenant-config.md` updated in the same change.
- Console: Invites card on the tenant drill-down with show-once copy modal (also adopted for client
  secrets); registration policy select on the tenant form; component/e2e coverage per RQ-0008.
- SDK/React: `inviteCode` plumbed through `registerWithPassword`; READMEs document the signup flow.

## Delivery plan

Three PRs, each independently shippable behind the `open` default:

1. **Service core** — model, policy, register gate, admin endpoints, MCP tools, seed passthrough,
   docs.
2. **Console** — invites card, show-once secret modal (shared), policy select.
3. **SDK/React + guides** — `inviteCode` parameter, signup example, guide updates.
