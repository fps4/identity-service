---
title: "0021: A credential's secret is minted by identity-service, never supplied by a seed file"
summary: "Split the OAuth credential in two: its structure stays declarative in seed config, but its secret becomes operational — minted by identity-service, returned once, and stored in the CONSUMING product's secret store. A re-seed may create a credential but never overwrite its secret. Adds create_application + create_client to the MCP surface, amending ADR-0011 §3."
status: accepted
last_updated: 2026-08-07
date: 2026-08-07
related:
  - ./0011-identity-data-operating-model-and-mcp-scope.md
  - ./0008-drop-sops-db-is-system-of-record.md
  - ./0007-management-api-mcp-and-standalone-identity-service.md
  - ./0020-application-aggregate.md
---

## Context

[ADR-0011](0011-identity-data-operating-model-and-mcp-scope.md) drew a clean seam: **structure is
declarative (git), state is imperative (DB)**, and put the OAuth client on the structural side. It also
asserted that "credentials are never expected in git."

Both are true of the *definition*. Neither is true of the **secret**, and the seam ran straight through
the middle of one object. In practice a confidential credential was declared like this:

```yaml
- id: skills-coach-coach
  grantTypes: [client_credentials]
  isConfidential: true
  secret: ${SKILLS_COACH_COACH_CLIENT_SECRET}
```

The value was interpolated at seed time from **identity-service's own** GitHub Actions secrets. So the
plaintext's system of record was a CI secret store — belonging to the identity provider's repo — while
identity-service held only a scrypt hash. That inverts ADR-0008's "the DB is the system of record" for
the one class of data where it matters most, and it produced three concrete failures:

1. **A re-seed silently reverted a rotation.** The seeder ran `if (c.secret) set.secretHash =
   hashSecret(c.secret)` unconditionally on every upsert. `rotate_client_secret` mints a new secret and
   returns it once; the next seed run overwrote the hash back to the CI value. The credential kept
   working against identity-service and stopped working for the consumer holding the rotated value —
   with no error at either end. Note the asymmetry this sat next to: an existing **user** was
   deliberately skipped on re-seed precisely so a re-run could never reset a password. Human credentials
   were already treated as operational; machine credentials were not.

2. **The wrong repo owned the secret.** `SKILLS_COACH_COACH_CLIENT_SECRET` had to be configured in the
   identity-service repo, but its only consumer is skills-coach — which needs its own copy to
   authenticate. Two stores, two owners, no reconciliation, and onboarding a product meant adding a
   secret to a repo the product's team may not own.

3. **It failed closed and took the whole seed path with it.** Interpolation throws if a referenced
   variable is unset, so removing those Actions secrets made every seed file naming a credential secret
   unrunnable — including the one carrying an urgent unrelated fix (an application's
   protected-resource registry). A structural change was blocked by a secret it did not need.

The trigger was mundane: `coach-mcp.fps4.nl` could not be authorised because the `skills-coach`
application had no `resources` entry, and the only sanctioned way to write one was a seed run that
demanded a client secret nobody wanted to keep supplying.

## Decision

**Split the credential by lifecycle, the same way ADR-0011 split identity data — and put the secret on
the operational side.**

**1. Structure stays declarative; the secret becomes operational.**

| Part of a credential | Nature | System of record | Write path |
|---|---|---|---|
| id, name, grant types, redirect URIs, audience, subject, claims, confidentiality | structural — reviewable, diffable | seed config, GitOps | PR → `seed-ds1` |
| the secret | operational — secret-bearing, rotatable | the **live DB** (ADR-0008) | `create_client` / `rotate_client_secret`, returned ONCE |

**2. A seed run may create a credential; it may never overwrite one's secret.** The secret hash moves
from `$set` to `$setOnInsert`, so it is written only when the upsert actually inserts. This is exactly
the insert-if-absent rule users have always had. A rotation can no longer be reverted by a re-seed.

**3. A confidential credential declared without a `secret:` is inserted with an unguessable random hash
that nobody holds.** It exists structurally and cannot authenticate until an operator calls
`rotate_client_secret` and stores the returned value with the consumer. Failing shut is the point: a
credential that has never been issued a secret should not be usable, and the operator's next step is
unambiguous.

**4. The secret flows outward, to the consumer.** identity-service mints it and returns it once; it is
stored in the **consuming product's** secret store. It is never written back into this repo. Onboarding
a product therefore adds **zero** secrets to identity-service.

**5. `create_application` and `create_client` join the MCP surface.** This amends ADR-0011 §3, which
removed structural provisioning from the agent surface. The rationale there was that clients are
declarative and inventable parameters shouldn't be minted by an agent — but a credential's secret is now
minted *here*, so registration must happen on a write surface; a seed file can only ever carry a secret
some other store already owns, which is the coupling this ADR removes. Destructive structural tools
(`delete_client`, `delete_application`) stay HTTP-only: least-privilege still argues against handing an
agent a way to remove a live credential, and registration does not need it.

**6. Exactly one credential is exempt.** `identity-admin-mcp` keeps its `${IDENTITY_ADMIN_CLIENT_SECRET}`
in `config/seed.yaml`, because minting a credential requires an admin token, which requires that
credential — it cannot bootstrap itself. It is also identity-service's own secret, so nothing crosses a
repo boundary. The bootstrap operator's password (`${SEED_CONSOLE_ADMIN_PASSWORD}`) is exempt for the
same reason and was already insert-if-absent. These two are the only `${...}` references left in any
seed file.

## Consequences

- **Positive:** the DB is the system of record for credential secrets, not a CI secret store — ADR-0008
  now holds for the data it was written about.
- **Positive:** rotation is safe. `rotate_client_secret` is durable against any number of re-seeds, so
  rotation becomes routine rather than something to be careful about.
- **Positive:** onboarding a product adds no secret to this repo. The seed file is pure structure and is
  dispatchable with nothing configured, so a structural change can never again be blocked by an
  unrelated secret.
- **Positive:** each secret has exactly one owner — the product that uses it.
- **Watch:** the handover is manual and one-shot. `create_client` / `rotate_client_secret` return the
  value once; if the operator loses it before storing it, the fix is another rotation, not recovery.
- **Watch:** a credential seeded with no secret is inert until rotated. That is intended, but it means
  "the seed ran green" no longer implies "the consumer can authenticate" — the runbook must say so.
- **Migration:** existing credentials keep their current secrets (the hash is only written on insert, and
  they already exist). `skills-coach-coach` and `mstr-specs-agent` lose their `secret:` lines and keep
  working; their secrets are already live in the DB and in their consumers' stores. The now-unreferenced
  Actions secrets in this repo can be deleted.
- **Amends** ADR-0011 §1 (the OAuth client is no longer wholly structural) and §3 (the MCP is no longer
  free of provisioning tools). The declarative/imperative seam itself is unchanged — this ADR moves one
  object across it and reports where the line actually falls.
