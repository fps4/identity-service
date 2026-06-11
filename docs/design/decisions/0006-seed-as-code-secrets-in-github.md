---
title: "0006: Seed definition in git, secret values in GitHub (a durable fallback)"
status: accepted
date: 2026-06-11
related:
  - ./0003-seed-config-not-admin-api.md
  - ../../product/RQ-0004-seed-config-provisioning.md
  - ../../product/RQ-0006-seed-as-code-and-recovery.md
  - ../../guides/deployment.md
---

## Context

[RQ-0004](../../product/RQ-0004-seed-config-provisioning.md) provisions tenants, clients, and users from
a `config/seed.yaml` loaded by `npm run seed`. That file was **gitignored** and lived only on an
operator's workstation; its secret *values* lived only in a gitignored `docker/.env`.

This bit us. component-auth's auth state (tenants, clients, users) lives in MongoDB. When the ds1
auto-deploy ([0007-era CI](../../guides/deployment.md)) first ran, a compose project-name change pointed
the stack at a **fresh, empty** mongo volume — every tenant/client/user was gone. The records were not
recoverable (passwords and client secrets are stored only as scrypt **hashes**, never plaintext), and
the *definition* of who should exist lived only on a laptop. There was **no durable, off-host source of
truth** from which to rebuild.

The need surfaced as *"my secrets are gone — can we keep them in a cloud service, as a backup / fallback?
is GitHub an option?"*

The two things that were missing are different and must not be conflated:

- **The definition** — which tenants/clients/users *should* exist (emails, client ids, audiences, roles,
  grant types). This is **not secret**.
- **The secret values** — user passwords and client secrets. These **are** secret.

## Decision

**Keep the seed *definition* in git and the secret *values* in GitHub; recover the database by re-seeding
from both.** Concretely:

1. **`config/seed.yaml` is committed** — it references every secret as `${ENV_VAR}` and contains **no
   plaintext**, so it is safe in version control. This makes the full topology durable, reviewable, and
   recoverable. (Amends RQ-0004 / ADR-0003, which gitignored the file out of caution; the `${ENV}`-only
   rule makes that caution unnecessary. `config/*.local.yaml` stays ignored for ad-hoc local overrides.)
2. **Secret values live in GitHub as repo/Environment Actions secrets** — the cloud "vault" / fallback.
   The same runtime client secret is mirrored in the consuming repo's Actions secret (e.g. the gateway's
   `MAESTRO_RUNTIME_CLIENT_SECRET`) so the two sides agree (US-0086).
3. **The mongo data volume is stable across deploys** — the deploy reconciles containers but never the
   volume (`down` without `-v`), so steady-state data is no longer wiped. The one-time loss was the
   project-rename, now fixed.
4. **Recovery = re-run the seeder** — the operator (or a host with mongo access) runs `npm run seed`
   with the secrets exported from the environment. Because the definition is in git and the values are in
   GitHub, the database is reconstructable from those two sources alone. Idempotent: tenants/clients are
   upserted, existing users left untouched (RQ-0004).

### Why GitHub Actions secrets (not a SaaS vault)

GitHub is already the deploy control plane and where the deploy-time secrets live, so it is the natural
fallback with no new dependency. Its one limitation is that secrets are **write-only** — an operator
cannot read a value back — so it is a *re-injection* source, not a *read-back* backup. That is acceptable
here: the values are also distributed to their human owners (passwords) and the consuming deployments
(client secrets), and a rotated value is simply re-set in both places. If read-back recovery is later
wanted, **SOPS-encrypted secrets committed to the repo** (only ciphertext touches GitHub — plaintext
stays sovereign, ADR-0002/0027 friendly) is the documented upgrade path; it is **out of scope** here.

### Why not CI auto-seed (yet)

Seeding needs Node + the `scripts/` loader, which the **production image does not contain** (`tsconfig`
`rootDir: src` excludes `scripts/`) and the socket-only ds1 runner cannot bind-mount a checkout into.
So seeding stays an **operator step** (RQ-0004's stance), now driven from committed config + GitHub
secrets. A seeder-capable image + a `workflow_dispatch` re-seed job is a possible follow-up.

## Consequences

- The full ds1 identity topology is now in git and rebuildable from GitHub after any data loss.
- No plaintext secret is ever committed; rotation = change the Actions secret (+ the consumer's mirror)
  and re-seed.
- Operators must keep the committed `config/seed.yaml` and the Actions-secret set in sync (a new client
  needs both an entry and a secret); the deployment guide documents the secret list.
- The deploy no longer wipes data, so re-seeding is needed only for first setup, a new tenant/client, or
  an explicit reset — not on every deploy.
