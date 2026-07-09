---
title: "0017: Product-runtime self-registration — operator-pinned client-registration invites, show-once secrets, self-service redemption"
summary: "Managed products (gateway, copilot, skills-coach) stop being seed data in identity-service's config/seed.yaml — where each product_runtime client embeds a foreign ${MAESTRO_*_DS1_SECRET}, coupling this repo's all-or-nothing seed to other products' secrets (the ds1 pipeline's red-wall). Decisions: a new ClientRegistration collection reusing ADR-0013's show-once/hashed/atomic-redemption mechanics; the invite PINS the client's authorization shape (tenant, id, audience, subject, claims:{role:product_runtime}) so the redeemer self-serves the SECRET ONLY, never the privilege; a public code-gated POST /v1/clients/register that creates-or-rotates the pinned client and returns the secret once; only an operator with admin:clients may mint an invite; the three foreign runtime clients (and their MAESTRO_*_DS1_SECRET refs) leave seed.yaml while identity-service's OWN runtime client stays; and deploy-ds1's product_runtime seed-integrity guard is removed, its intent relocating to maestro as an alert. Amends ADR-0006/RQ-0004 for foreign products only; supersedes the 'register via seed config' path in the product-runtime-credential reference for managed products."
status: proposed
last_updated: 2026-07-04
date: 2026-07-04
related:
  - ./0006-seed-as-code-secrets-in-github.md
  - ./0007-management-api-mcp-and-standalone-identity-service.md
  - ./0011-identity-data-operating-model-and-mcp-scope.md
  - ./0013-invite-code-gated-registration.md
  - ../../product/RQ-0004-seed-config-provisioning.md
  - ../../product/RQ-0018-product-runtime-self-registration.md
  - ../../reference/product-runtime-credential.md
  - ../../guides/deployment.md
  - ../../guides/ds1-delivery-pipeline-findings.md
---

> **Reworked by [ADR-0020](0020-application-aggregate.md) (2026-07-09):** a product runtime no longer
> self-registers a standalone *client* — it registers a runtime **credential under its Application**. The
> application (and its role catalogue) is the durable, reviewed object; the runtime credential is the
> rotatable auth material beneath it, carrying an `audience` override (e.g. `maestro-workspace`).

## Context

A managed product's runtime authenticates to maestro as a `product_runtime` principal by exchanging a
`client_credentials` client for a short-lived JWT (`aud=maestro-workspace`), one registered client per
(product, deployment) — [product-runtime-credential](../../reference/product-runtime-credential.md).
Today those clients are **seed data in this repo**: `config/seed.yaml` declares
`sovereign-llm-gateway-ds1`, `sovereign-copilot-ds1`, and `skills-coach-ds1` with
`secret: ${MAESTRO_GATEWAY_DS1_SECRET}` / `${MAESTRO_COPILOT_DS1_SECRET}` / `${MAESTRO_COACH_DS1_SECRET}`.

That couples identity-service's bootstrap to **other products'** secrets, and the seeder is
**all-or-nothing** on `${…}` presence — one unset reference aborts the whole run before anything is
written. The [ds1 delivery-pipeline findings](../../guides/ds1-delivery-pipeline-findings.md) trace both
red workflows to this: `seed-ds1` aborts on the first missing foreign secret (Symptom 1), and
`deploy-ds1`'s post-deploy guard — which counts `product_runtime` clients in seed vs. the live DB —
then red-walls every merge to `main` because the DB is stale (Symptom 2).

But those clients are **day-2 data other products own**, not identity-service's bootstrap. ADR-0007 made
the **live DB the system of record** and built a management plane (`/admin/v1`, MCP, console) precisely
for day-2 changes; ADR-0006/RQ-0004's seed-as-code was scoped to standing up an *empty* deployment. And
ADR-0013 already shipped the exact primitive a self-service registration needs: an operator-issued,
**show-once**, SHA-256-hashed, atomically-redeemed invite. The gap is only that today's invite provisions
a **user**; we need one that provisions a **client**.

Considered alternatives:

- **Operator creates the client directly and hands the secret out-of-band** (today's only non-seed path).
  The plaintext transits the operator and some side channel; every rotation is a manual operator +
  hand-off; nothing is attributed to the product. No self-service.
- **A per-product scoped admin credential** — give each product a standing `client_credentials` principal
  scoped to `admin:clients:<its-client>`. Requires extending the coarse `admin:clients` scope into
  resource-scoped grants in the authz core (`requireAdmin`), and leaves every product holding a
  long-lived admin-family credential. Most flexible, biggest blast radius, largest change.
- **Operator-pinned registration invite (chosen)** — the operator vouches for the client's *shape* once;
  the product redeems a one-time code to obtain the *secret* itself, directly into its own vault.

## Decision

**1. A first-class `ClientRegistration` collection, reusing ADR-0013's code mechanics.** A high-entropy
code is returned **once**; only its SHA-256 digest is stored (the same digest scheme as invites —
`generateInviteCode` / `inviteCodeDigest`, deliberately *not* the salted-scrypt client-secret scheme,
because the code must be findable by value). It carries `expiresAt` (default 7 days), `maxUses` (default
1), `revokedAt`, and derived status (pending / redeemed / expired / revoked). Kept separate from the
user `Invite` collection so the user-invite shape (email, roles) stays clean.

**2. The registration PINS the client's authorization shape; the redeemer receives only the secret.** At
creation the operator fixes the full template: `tenantId`, `clientId`, `name`, `audience`, `subject`,
`claims` (`role: product_runtime`, `email`), with `grantTypes` forced to `[client_credentials]` and
`isConfidential: true`. Redemption ignores any client fields in its body — it cannot choose the tenant,
widen scope, or change the subject. **The privilege is operator-vouched; only the secret is
self-served.** This is the load-bearing security property: a redeemer (or a leaked code) can obtain *one*
product_runtime credential of a *pre-approved* shape and nothing more.

**3. Only an operator with `admin:clients` may mint a registration invite**, via the management plane
with HTTP / MCP / console parity (RQ-0009): create (returns the code once), list (status; never the code,
never a secret), revoke. All three are audited (ADR-0007), attributed to the operator. This is the trust
anchor and it resolves the bootstrap chicken-and-egg: the product needs **no** standing credential to
register — just the one-time code.

**4. Redemption is a public, code-gated `POST /v1/clients/register`.** It mirrors the existing
code-gated user self-registration (`POST /v1/tenants/:tenantId/register` with `inviteCode`); the tenant
is taken from the pinned invite, not the URL, so the product cannot pick it. Redemption is a single
atomic countdown against `usesRemaining` (as in ADR-0013, so a race cannot oversubscribe) that
**creates the pinned client if absent, else rotates its secret** — and returns the secret **once**
(`createClient` / `rotateClientSecret` already return-once, hash-only). Redemption is audited to the
client `subject`. Invalid / expired / revoked / exhausted codes return **one generic error** so codes
cannot be probed (ADR-0013).

**5. The three foreign product_runtime clients leave `config/seed.yaml`.**
`sovereign-llm-gateway-ds1`, `sovereign-copilot-ds1`, `skills-coach-ds1` and their
`MAESTRO_*_DS1_SECRET` references are deleted from the seed. identity-service's **own** runtime client,
`identity-service-ds1-runtime`, **stays** — its `${MAESTRO_RUNTIME_CLIENT_SECRET}` is identity-service's
own secret (already set; the same value the running service presents to self-mint, so seed and runtime
can't drift). This **amends ADR-0006 / RQ-0004 for foreign products only**, and supersedes the
"[Registering a runtime client (seed config)](../../reference/product-runtime-credential.md#registering-a-runtime-client-seed-config)"
path as the recommended route for *managed* products.

**6. `deploy-ds1`'s product_runtime seed-integrity guard is removed.** With the foreign clients no longer
seed data, the guard that counts seed vs. DB `product_runtime` clients has nothing to compare and can no
longer red-wall unrelated merges (Symptom 2). Its legitimate intent — "are all managed runtimes able to
mint?" — belongs to **maestro's** ops view, which already knows which products it expects telemetry from,
as an **alert**, not this service's deploy gate. (Cross-repo; tracked in RQ-0018.)

## Consequences

- **+ Unblocks the ds1 pipeline.** Seed's required-secret set drops to the **3 already set**
  (`IDENTITY_ADMIN_CLIENT_SECRET`, `MAESTRO_RUNTIME_CLIENT_SECRET`, `SEED_CONSOLE_ADMIN_PASSWORD` — plus
  the tenant user passwords, which are separately in scope), so `seed-ds1` can complete (Symptom 1); the
  removed guard ends the red-wall (Symptom 2).
- **+ Single-sourced secret.** The credential lives only as a DB hash and, once, in the product's own
  vault — there is no seed copy to drift against. Rotation is a fresh operator-issued invite (or the
  product re-redeeming a multi-use one).
- **+ Per-product self-service and audit.** Each product pulls its secret straight into its own Actions
  secrets / runtime env; creation, redemption, and revocation are attributed on the management plane.
- **− New surface to build.** A `ClientRegistration` collection, a redemption route, admin-plane
  create/list/revoke, and a console surface (RQ-0018) — versus reusing seed-as-code.
- **− Rotation needs an operator** to mint a fresh invite (or a multi-use one). Accepted: runtime-secret
  rotation is rare, and alternative C's standing admin credential is the worse trade.
- **− A leaked *unredeemed* code yields one product_runtime secret.** Bounded by design: a single client,
  single use, expiring, revocable, and shape-pinned — no privilege beyond that pre-approved
  `product_runtime` principal. Same threat model ADR-0013 already accepts for user invites.
- **Neutral: the SDK is unchanged.** Its `client_credentials` token provider still just reads a
  configured `client_id` + `client_secret`; where that secret *came from* is invisible to it.
