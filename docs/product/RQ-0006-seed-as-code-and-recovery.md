---
title: "RQ-0006 — Seed-as-code: a GitHub-backed, recoverable identity definition"
status: current
last_updated: 2026-06-11
owners: [architect]
related:
  - docs/design/decisions/0006-seed-as-code-secrets-in-github.md
  - docs/product/RQ-0004-seed-config-provisioning.md
  - docs/guides/deployment.md
maestro:
  feature: seed-as-code-recovery
  kind: functional_spec
  summary: |
    Make the deployed identity data (tenants, app clients, users) survivable. Commit the seed
    DEFINITION to git with every secret written as an ${ENV} reference (no plaintext), and keep the
    secret VALUES in GitHub as Actions secrets. If the auth database is ever lost, re-running the
    one-command seeder rebuilds it from the committed definition plus the GitHub-held secrets. The
    deploy no longer wipes the data volume.
---

# RQ-0006 — Seed-as-code: a GitHub-backed, recoverable identity definition

- **Status:** accepted
- **Raised:** 2026-06-11
- **Owner:** @farid (architect)

## Problem

The ds1 auth database (tenants, clients, users) was wiped by a one-time deploy volume change and could
not be recovered: the records held only password/secret **hashes**, and the *definition* of who should
exist lived only on a workstation in a gitignored file. There was no durable, off-host fallback.

## Story

As the **architect/operator**, I want the deployed identity definition to live in **GitHub** with its
secret values held as **Actions secrets**, so that if the database is lost I can **rebuild it with one
command** instead of reconstructing tenants/clients/users from memory.

## Acceptance criteria

- The seed **definition** (`config/seed.yaml`) SHALL be **committed** and SHALL contain **no plaintext
  secret** — every password / client secret SHALL be an `${ENV_VAR}` reference resolved at run time.
- Secret **values** SHALL be held as repo/Environment **GitHub Actions secrets**; a runtime client
  secret SHALL match its consumer-side mirror (e.g. the gateway's `MAESTRO_RUNTIME_CLIENT_SECRET`).
- Running `npm run seed` with those secrets in the environment SHALL **reconstruct** every tenant,
  client, and user — idempotently (tenants/clients upserted; existing users untouched, per RQ-0004).
- The deploy SHALL NOT wipe the mongo data volume (steady-state data persists across deploys).
- Passwords SHALL be stored only as hashes; plaintext SHALL live only in GitHub secrets + with the human
  owner, never in git.
- The deployment guide SHALL list the required Actions secrets and the one-command recovery procedure.

## Out of scope

- **CI auto-seed** (the production image has no seeder; the socket-only runner can't mount a checkout) —
  seeding stays an operator step. A seeder-capable image + a `workflow_dispatch` re-seed job is a
  possible follow-up.
- **Read-back recovery** of a secret value (Actions secrets are write-only) — the documented upgrade is
  SOPS-encrypted secrets committed to the repo. Out of scope here.
