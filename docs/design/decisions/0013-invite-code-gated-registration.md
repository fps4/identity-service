---
title: "0013: Invite-code-gated registration — hashed show-once codes, atomic redemption, and an invite gate on federated JIT provisioning"
summary: "RQ-0013 closes open self-registration behind operator-issued invite codes. Decisions: a per-tenant registration policy ('open'|'invite'|'closed') on the existing oauth block; a first-class invites collection storing only a SHA-256 digest of a high-entropy show-once code (deliberately NOT the salted-scrypt secret scheme — the code must be findable by value); redemption as a single conditional findOneAndUpdate so racing registrations cannot oversubscribe a single-use code; email-bound invites set emailVerified on redemption (the operator vouched for the address — the same trust signal ADR-0012 accepts from Google); one generic invalid_invite error so codes cannot be probed; and, on invite/closed tenants, denial of federated logins that would JIT-provision a new user, closing the bypass ADR-0012's provisioning would otherwise open. No mail provider is required or introduced — out-of-band distribution is the point."
status: accepted
last_updated: 2026-07-03
date: 2026-07-03
related:
  - ./0001-local-credential-idp.md
  - ./0003-seed-config-not-admin-api.md
  - ./0007-management-api-mcp-and-standalone-identity-service.md
  - ./0012-federated-identity-and-account-linking.md
  - ../../product/RQ-0013-invite-only-registration.md
  - ../../product/RQ-0002-local-password-idp.md
---

## Context

RQ-0002 shipped open self-registration: any caller who can reach
`POST /v1/tenants/:tenantId/register` on a local-IdP tenant can create an account, guarded only by a
per-tenant registrations-per-minute cap (`service/src/services/users.ts`). Closed products want
self-service signup for invited people only. The obvious alternatives:

- **Pre-create accounts via the admin plane** (today's workaround) — the operator types every email
  and initial password; the invitee never self-serves. Doesn't scale past a handful of users.
- **Email-verification-gated signup** — blocked on the mail provider ADR-0001 deferred, and
  verification alone doesn't make registration *invite-only*; it only proves mailbox ownership.
- **Invite codes** — the operator mints a code and sends it over a channel they already have. Needs
  no mail integration, gives per-invite control (email binding, roles, expiry, uses, revocation), and
  produces an auditable trail on the management plane ADR-0007 already built.

Two existing constraints shape the design. First, client secrets set the precedent for sensitive
material: **returned once, only a hash persisted** (`/admin/v1/clients`); invites should behave the
same. Second, ADR-0012's JIT provisioning creates a user on first federated login — an invite-only
tenant with Google enabled would otherwise let anyone with a Google account walk around the gate.

## Decision

**1. Registration policy is a tenant-level enum on the existing `oauth` block.**
`oauth.registration?: 'open' | 'invite' | 'closed'`, default `open` — absent config behaves exactly
as today, so the change is additive (AGENTS.md guardrail). Seed config (ADR-0003/0006) and the admin
plane both set it; it is operational, DB-owned state per ADR-0011.

**2. Invites are a first-class collection, and the code is stored as an unsalted SHA-256 digest —
deliberately not the scrypt secret scheme.** Redemption must *look the invite up by code value*; a
per-record salted hash (utils/hash.ts) cannot be indexed for that. The safety argument is entropy,
not salt: codes are ~60 bits of CSPRNG randomness from an unambiguous alphabet (no `0/O/1/I`,
grouped `XXXX-XXXX-XXXX`), so precomputation is useless and online guessing is bounded by the
registration rate cap. The digest gets a unique index. Schema:
`{ _id, tenantId, codeDigest, email?, roles?, maxUses, usedCount, expiresAt, revokedAt?, createdBy?,
note? }`. The plaintext code is returned **once** at creation, mirroring the client-secret contract;
list responses expose derived status (pending / redeemed / expired / revoked), never the code.

**3. Redemption is one conditional write, ordered after input validation.** The gate is a single
`findOneAndUpdate` matching `{ codeDigest, tenantId, revokedAt: null, expiresAt > now,
usedCount < maxUses }` with `$inc: { usedCount: 1 }` — two registrations racing a single-use code
cannot both match, with no transaction needed. It runs **after** email/password/tenant validation so
a rejected registration never burns a use; if user creation itself subsequently fails (duplicate
email race), the use is decremented back. Roles are validated against the tenant's `allowedRoles` at
invite **creation** (fail loud at the operator, not the invitee) and stamped at redemption.

**4. An email-bound invite sets `emailVerified: true` on redemption.** ADR-0012 already accepts "a
trusted party vouched for this address" as the linking gate (Google's `email_verified`). An operator
who sent a code to a specific address is the same signal: possession of the code proves control of
the channel it was sent to. Unbound (open/cohort) invites leave `emailVerified: false` — they vouch
for membership, not for an address. Email matching uses the existing normalization (trim/lowercase).

**5. One generic failure, `403 invalid_invite`.** Unknown, expired, revoked, exhausted, and
wrong-email-binding are indistinguishable to the caller ("invalid or expired invite code"), so codes
cannot be probed for state; a missing code on an `invite` tenant is the distinct, actionable
`invite_required`, and a `closed` tenant returns `registration_closed`. Same
`{ error, message }` envelope as the rest of `/v1` (`UserServiceError`).

**6. Invite-only gates federated JIT provisioning too.** On an `invite` or `closed` tenant,
`provisionFederatedUser` denies a login that would create a **new** user, surfacing through the
existing trusted-redirect `access_denied` path (no token, no redirect to unvalidated URIs). Existing
users — federated, local, or linked — authenticate unchanged. An invitee registers locally with
their code first; their Google identity then auto-links on the verified-email rule (ADR-0012), so
the invite carries over without threading it through the OAuth `state`. Accepting invites inside the
redirect flow is deferred until a product needs Google-first signup on a closed tenant.

**7. Management-plane parity and audit.** Create/list/revoke ship on `/admin/v1`
(`POST /tenants/:tenantId/invites`, `GET` same, `POST /invites/:id/revoke`), as MCP tools, and in
the console (RQ-0009 parity; ADR-0007 audit: `invite.create`, `invite.revoke`, plus redemption
stamped with the invite id). The console presents the show-once code in a **copy-friendly modal**
shared with client-secret creation/rotation — replacing the 30-second toast, which was already the
weakest step of the secret-handling flow.

## Consequences

- **Positive:** closed products get self-service signup with no mail dependency, per-invite
  control, and a full audit trail; the operator workflow drops from "create every account" to "mint
  a code".
- **Positive:** on invite-only tenants the public `email_taken` enumeration surface (RQ-0002's known
  weak spot) is reachable only by invite holders, and email-bound invites give those users verified
  emails — narrowing two gaps ahead of the mail-provider work.
- **Positive:** the show-once modal fixes secret delivery for client credentials as a side effect.
- **Watch — the digest choice is entropy-dependent.** The unsalted SHA-256 lookup is safe only while
  codes stay long CSPRNG strings; shortening them or making them human-chosen re-opens offline
  guessing and must be re-decided here.
- **Watch — the federated gate changes first-login behaviour on closed tenants.** A Google-first
  invitee sees `access_denied` until they redeem locally; consumer login UIs on invite-only tenants
  should route new users to the invite signup path. Documented in the tenant-config guide.
- **Watch — `emailVerified` from an invite is operator-trust, not mailbox-proof.** It inherits the
  ADR-0012 stance; when a real verification channel lands (ADR-0001's deferral), email-bound invites
  should migrate to sending a verification link instead of asserting directly.
- **Refines** ADR-0001 (registration lifecycle grows a policy gate while its email deferrals stand)
  and **extends** ADR-0012 (JIT provisioning now consults tenant policy). ADR-0003/0006 unaffected:
  invites are runtime operational data, never seed material.
