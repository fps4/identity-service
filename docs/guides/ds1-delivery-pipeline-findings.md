---
title: ds1 delivery pipeline — deploy-ds1 & seed-ds1 failure findings
summary: Why deploy-ds1 and seed-ds1 have been red since 2026-06-30 — the monolithic seed's all-or-nothing secret coupling and the post-deploy product_runtime guard — plus recommendations for the deploy-ds1 rework.
status: current
last_updated: 2026-07-04
owners: [architect]
related:
  - docs/guides/deployment.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
  - docs/design/decisions/0008-drop-sops-db-is-system-of-record.md
---

# ds1 delivery pipeline — failure findings

Findings from investigating why the ds1 delivery workflows fail, captured for the planned **deploy-ds1
rework**. The workflows live in [`.github/workflows/deploy-ds1.yml`](../../.github/workflows/deploy-ds1.yml)
and [`.github/workflows/seed-ds1.yml`](../../.github/workflows/seed-ds1.yml); the fleet/ops side is
maestro's (see the [observability guide](./deployment.md)).

## Summary

`deploy-ds1` and `seed-ds1` have **failed on every run since 2026-06-30** (last green `seed-ds1`:
2026-06-26). Neither is a build/code failure — the Definition of Done build gate is green. There are two
coupled root causes:

1. **`seed-ds1` cannot run** — `config/seed.yaml` references **16** secrets; only **3** exist as repo
   Actions secrets. The seeder validates all `${…}` references up front and aborts on the first missing
   one before writing anything.
2. **`deploy-ds1` fails a post-deploy guard** — it requires the live ds1 auth DB to hold at least the
   `product_runtime` clients `config/seed.yaml` declares (4); the DB has 3. This is *downstream* of (1):
   the DB is stale because seeds can't run.

## Symptom 1 — `seed-ds1` aborts on missing secrets

```
> tsx scripts/seed.ts
Seed config references env var SEED_DEMO_PASSWORD which is unset
##[error] Process completed with exit code 1
```

`config/seed.yaml` is the **monolithic, all-tenants** bootstrap (demo, sovereign-copilot, maestro,
skills-coach, plus identity-service ops/operators). The seeder is **all-or-nothing** on secret presence:
one unset reference fails the whole run.

- **Set** (repo Actions secrets): `IDENTITY_ADMIN_CLIENT_SECRET`, `MAESTRO_RUNTIME_CLIENT_SECRET`,
  `SEED_CONSOLE_ADMIN_PASSWORD`.
- **Missing (13):** `SEED_DEMO_PASSWORD`, `SEED_ADMIN_PASSWORD`, `SEED_SOVEREIGN_COPILOT_ADMIN_PASSWORD`,
  `SEED_SOVEREIGN_COPILOT_DEMO_PASSWORD`, `MAESTRO_GATEWAY_DS1_SECRET`, `MAESTRO_COPILOT_DS1_SECRET`,
  `MAESTRO_COACH_DS1_SECRET`, `SEED_MAESTRO_PO_PASSWORD`, `SEED_MAESTRO_SA_PASSWORD`,
  `SEED_MAESTRO_ADMIN_PASSWORD`, `SEED_COACH_ADMIN_PASSWORD`, `SEED_COACH_LEARNER_PASSWORD`,
  `SEED_COACH_OFFICER_PASSWORD`.

**Design smell:** seeding identity-service on ds1 is coupled to **other products'** secrets — their
runtime client secrets (gateway/copilot/coach) and demo/learner user passwords — which arguably belong to
those products' own pipelines, not identity-service's Actions secrets. (Caveat: org-level secrets would
not appear in a repo secret list, but `SEED_DEMO_PASSWORD` is genuinely absent — the run proves it.)

## Symptom 2 — `deploy-ds1` product_runtime seed-integrity guard

```
config/seed.yaml declares 4 product_runtime client(s)
ds1 auth DB (identity-service) has 3 product_runtime client(s)
::error:: Service-authorization gap: only 3/4 product_runtime client(s) seeded on ds1.
::error:: Managed-product runtimes cannot mint a token, so maestro will drop their telemetry/logs.
```

The build / compose / health steps pass; this **post-deploy guard** exits 1. It can detect the gap but
cannot remediate it (seeding is a separate workflow it does not run), and it re-fires on every
DoD → deploy chain — so **any merge to `main` shows a red deploy regardless of what the merge changed**.

## Related fix already landed (needs a reseed to take effect)

maestro migrated the former "Shared Components" product to `identity-service`
(`fps4/maestro` `config/products.yaml`: `id: identity-service`, `runtime@identity-service.fps4.nl`).
identity-service's runtime side already matched, but its **seed** still declared the old `components-ds1`
client, so the runtime's `identity-service-ds1-runtime` client never existed in the DB and its
self-minted maestro telemetry would `401`.

Fixed by renaming the seed client `components-ds1` → `identity-service-ds1-runtime` and using a single
`MAESTRO_RUNTIME_CLIENT_SECRET` for both the seed-stored and runtime-presented secret (so they cannot
drift). **This only takes effect after a reseed**, which is blocked by Symptom 1.

## Recommendations for the deploy-ds1 rework

- **Decouple seeding from other products' secrets.** Split `config/seed.yaml` so ds1 seeds only what
  identity-service owns (needs only the 3 secrets already set), or move each product's runtime-client seed
  into that product's own pipeline.
- **Make seeding not all-or-nothing.** Seed per tenant so a missing optional secret skips that tenant
  instead of aborting the entire run.
- **Reconsider the product_runtime guard in `deploy-ds1`.** It gates the *deploy* on *seed-data* state it
  cannot fix, red-walling unrelated merges. Options: make it a non-blocking warning that alerts maestro;
  fold seed-then-verify into one gated step; or move the check into `seed-ds1`.
- **Do not re-fire the deploy (and its guard) on every green DoD.** Consider gating the deploy on actual
  service changes rather than every DoD completion.

## Evidence

- `deploy-ds1` failure: run `28701064934` (and every run back through 2026-07-03).
- `seed-ds1` failure: run `28701031855`; last green `28225698031` (2026-06-26).
- maestro product registry: `fps4/maestro` `config/products.yaml` (`id: identity-service`).
- The seed is the system of record per [ADR-0008](../design/decisions/0008-drop-sops-db-is-system-of-record.md);
  the deploy ships the service, not the seed data (a re-seed is a separate operator step).
