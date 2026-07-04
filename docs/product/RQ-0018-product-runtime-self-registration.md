---
title: "RQ-0018 — Product-runtime self-registration (operator-issued client-registration invites)"
status: proposed
last_updated: 2026-07-04
owners: [architect]
related:
  - docs/product/RQ-0004-seed-config-provisioning.md
  - docs/product/RQ-0009-console-api-parity.md
  - docs/product/RQ-0013-invite-only-registration.md
  - docs/product/RQ-0017-console-clients-invites-directory.md
  - docs/design/decisions/0017-product-runtime-self-registration-invites.md
  - docs/reference/product-runtime-credential.md
  - docs/guides/deployment.md
  - docs/guides/ds1-delivery-pipeline-findings.md
maestro:
  feature: product-runtime-self-registration
  kind: functional_spec
  summary: |
    Let each managed product (gateway, copilot, skills-coach) register its own deployment's
    product_runtime client and obtain the client secret itself, from a one-time code an
    identity-service operator issues — instead of that client and its secret living in
    identity-service's config/seed.yaml as a foreign ${MAESTRO_*_DS1_SECRET}. The operator mints a
    client-registration invite that PINS the client's shape (tenant, id, audience, subject,
    claims:{role:product_runtime}); the product redeems the code at a public endpoint, which
    creates-or-rotates exactly that client and returns the secret ONCE. Codes are shown once, stored
    hashed, expiring, single-use by default, and revocable (reusing the RQ-0013 invite mechanics). The
    redeemer self-serves only the secret, never the privilege. The three foreign runtime clients leave
    seed.yaml; identity-service's own runtime client stays.
---

# RQ-0018 — Product-runtime self-registration

- **Status:** proposed
- **Raised:** 2026-07-04
- **Owner:** @farid (architect)
- **Decision:** [ADR-0017](../design/decisions/0017-product-runtime-self-registration-invites.md) —
  the ClientRegistration collection, the shape-pinning rule, atomic create-or-rotate redemption, the
  seed change, and the guard relocation.

## Why

A managed product's runtime authenticates to maestro as a `product_runtime` principal via a
`client_credentials` client — one per (product, deployment)
([product-runtime-credential](../reference/product-runtime-credential.md)). Today those clients are
**seed data in identity-service**: `config/seed.yaml` embeds `sovereign-llm-gateway-ds1`,
`sovereign-copilot-ds1`, and `skills-coach-ds1` with `secret: ${MAESTRO_GATEWAY_DS1_SECRET}` /
`${MAESTRO_COPILOT_DS1_SECRET}` / `${MAESTRO_COACH_DS1_SECRET}`.

That couples this repo's bootstrap to **other products'** secrets, and the seeder is all-or-nothing —
one missing reference aborts the whole run. The
[ds1 delivery-pipeline findings](../guides/ds1-delivery-pipeline-findings.md) trace both red workflows
to exactly this: `seed-ds1` aborts on the first absent foreign secret, and `deploy-ds1`'s guard then
red-walls every merge to `main`. But these clients are **day-2 data other products own** — they belong
on the management plane ADR-0007 built, not in identity-service's seed or Actions secrets. RQ-0013
already shipped the pattern we need (operator-issued, show-once, hashed, atomically-redeemed invites);
this extends it from provisioning a *user* to provisioning a *client*.

**Story.** *As a product team (gateway / copilot / skills-coach), I want to register my deployment's
runtime client and pull its secret myself from a one-time code an identity-service operator gives me,
so my runtime can mint maestro tokens without my secret ever living in identity-service's seed or
Actions secrets — and so a missing secret of mine can never wedge identity-service's bootstrap.*

## Scope

1. **Operator-issued client-registration invites** on the management plane (HTTP `/admin/v1`, MCP
   tools, console — parity per RQ-0009): create (returns the code **once**), list (status: pending /
   redeemed / expired / revoked; never the code, never a secret), revoke. All three audited (ADR-0007),
   attributed to the operator. Requires the `admin:clients` scope.
2. **The invite pins the client template** — `tenantId`, `clientId`, `name`, `audience`, `subject`,
   `claims` (`role: product_runtime`, `email`); `grantTypes` is fixed to `[client_credentials]` and
   `isConfidential: true`. Invite options: `expiresAt` (default 7 days), `maxUses` (default 1),
   free-text note.
3. **Redemption** — a public, code-gated `POST /v1/clients/register` taking the code (the tenant comes
   from the invite, not the URL). Atomic single countdown against remaining uses; **creates the pinned
   client if absent, else rotates its secret**; returns the secret **once**. The body cannot alter the
   pinned shape — extra client fields are ignored. Redemption audited to the client `subject`. Invalid
   / expired / revoked / exhausted → **one generic error** (no probing).
4. **Seed change** — remove `sovereign-llm-gateway-ds1`, `sovereign-copilot-ds1`, `skills-coach-ds1`
   and their `MAESTRO_*_DS1_SECRET` references from `config/seed.yaml`. Keep identity-service's own
   `identity-service-ds1-runtime` (its `${MAESTRO_RUNTIME_CLIENT_SECRET}` is identity-service-owned).
   Seed's required secret set drops to the ones already provisioned.
5. **Console surface** — extend the RQ-0017 clients/invites directory to create / list / revoke
   client-registration invites, plus a redeem page a human product operator can paste a code into to
   retrieve the secret once.
6. **Guard relocation (cross-repo)** — `deploy-ds1`'s product_runtime seed-integrity guard is removed
   (the clients are no longer seed data). The "are all managed runtimes registered and able to mint?"
   check moves to **maestro** as an alert, not this service's deploy gate.

## Acceptance criteria

- Seeding a fresh ds1 DB completes with only the already-set secrets (no `MAESTRO_*_DS1_SECRET`
  required).
- An operator can mint a client-registration invite via HTTP, MCP, **and** the console; the code is
  shown exactly once; listing never returns the code or any secret.
- Redeeming a valid code creates the client with **exactly** the pinned shape (tenant, id, audience,
  subject, `claims.role=product_runtime`, `client_credentials`); the returned secret mints a JWT with
  `aud=maestro-workspace` and `role=product_runtime`.
- A redeemer **cannot** change the tenant, widen scope, or alter the subject — extra body fields are
  ignored.
- Re-issuing an invite for an already-registered client **rotates** its secret rather than duplicating
  the client.
- Expired, revoked, and over-used codes all return the same generic error.
- Create, redeem, and revoke are all present in the audit log with the right attribution.

## Out of scope

- identity-service's **own** runtime client (`identity-service-ds1-runtime`) — it stays seeded; its
  secret is identity-service-owned.
- Standing, resource-scoped admin credentials per product (ADR-0017 alternative C) — deferred.
- Any mail delivery of codes — distribution stays out-of-band, as in RQ-0013.
