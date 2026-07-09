---
title: "0020: The Application aggregate — one application, many credentials, app-level roles + audience"
summary: "Make the Application (a product) the first-class unit instead of the OAuth client. An application owns its name, default audience, and role catalogue, and is the thing users are assigned to; OAuth clients become typed CREDENTIALS (web / machine-runtime / CI) under an application, inheriting its audience. Roles, audience, and assignments move up from the client to the application (re-keying ADR-0019 assignments/invites from clientId to applicationId). Azure-AD-style app registration; does not reintroduce Tenant."
status: accepted
last_updated: 2026-07-09
date: 2026-07-09
related:
  - ./0019-application-assignments-and-app-roles.md
  - ./0018-collapse-tenant-into-deployment.md
  - ./0017-product-runtime-self-registration-invites.md
  - ./0010-console-operator-authentication.md
---

## Context

After [ADR-0019](0019-application-assignments-and-app-roles.md) the OAuth **client** is still the unit of
everything: a credential *and* the audience *and* the role catalogue *and* the thing users are assigned
to. But a real product is not one client — it is a **web frontend** (a public client, user login) *and* a
**backend runtime** (a confidential client-credentials principal, ADR-0017) *and* sometimes CI/machine
clients, all belonging to the same product. Today those land as separate, unrelated `oauth_clients` rows,
the role catalogue is stuck on whichever one an operator happened to attach it to, and the audience is
hand-synced across them. Operators see "separate application registrations and separate runtime
registrations" for what is, to them, one thing.

The mental model people actually hold — and the one Azure AD's "app registration" encodes — is: an
**Application** is the product; it has **app roles** (defined once, for the whole app), an **audience**,
assigned **users**, and one or more **credentials** (secrets/keys/clients) that authenticate *as* it.
This ADR adopts that.

This is a refinement of ADR-0018/0019, **not** a reversal. The realm is still single and the user pool
still shared; an assignment is still *membership* over that shared pool, now against an application rather
than a client. Application is a grouping of credentials + roles + members — it is **not** a Tenant (it does
not own or partition users).

## Decision

**1. The Application is a first-class entity.** New `applications` collection:

| field | meaning |
|---|---|
| `_id`, `name` | the product |
| `audience` | the default token `aud` for tokens minted through this application's credentials |
| `roles` | the application's role catalogue (`AppRole[]` from ADR-0019) — one catalogue for the whole app |
| timestamps | |

**2. OAuth clients become typed CREDENTIALS under an application.** `oauth_clients` gains
`applicationId` (required). A credential keeps its `_id` (the `client_id`), `secretHash`, `grantTypes`,
`redirectUris`, `scopes`, `isConfidential`, and (for machine principals) `subject`/`claims`. What moves
**off** the client and **up** to the application: the **role catalogue** and the **default audience**.
A credential MAY still carry an `audience` **override** (a product runtime reports to maestro, so its token
`aud` is `maestro-workspace`, not its own app's audience — the override handles exactly this). Credential
"type" is expressed as today by its grant types: `password`/`authorization_code` = a user-login (web)
credential; `client_credentials` = a machine/runtime credential.

**3. Roles, audience, and assignments are application-scoped.**
- `assignments` re-key from `clientId` → `applicationId`; unique `{userId, applicationId}`. A user assigned
  to an application may log in through **any** of its user-login credentials, and the token `roles` are the
  application's roles from that assignment.
- `invites` re-key from `clientId` → `applicationId` — an invite entitles the redeemer to an *application*.
- The issuance gate (ADR-0019) is unchanged in spirit: at a user grant, resolve the credential → its
  application, require an active assignment for `(user, application)`, deny otherwise, and stamp
  `roles = assignment.roles`, `aud = credential.audience ?? application.audience`.

**4. Runtime self-registration (ADR-0017) becomes "add a credential to an application."** A product no
longer self-registers a standalone runtime *client*; it registers a runtime *credential under its
application*. The application (and its role catalogue) is the durable, reviewed object; credentials are the
rotatable auth material beneath it.

**5. The operator (ADR-0010) is unchanged in mechanism.** `identity-console` becomes an **application**
whose catalogue holds `platform_admin`, with a user-login credential under it; the operator holds an
assignment to that *application*. `ADMIN_OPERATOR_ROLES` still maps the `roles` claim to admin authority.

## Consequences

- **Positive — one product = one registration.** Operators manage an application with its credentials,
  roles, and members in one place; the "web vs runtime" split becomes two credentials under one app, not
  two unrelated registrations. Roles are defined once per application, as expected.
- **Positive — audience stops drifting.** It is owned by the application and inherited; the credential
  override is the deliberate exception (runtimes aimed at maestro), not the norm.
- **Reworks ADR-0019** (assignments/invites/roles/catalogue re-key from client to application) and
  **ADR-0017** (runtime = a credential, not a client). Does **not** reverse ADR-0018/0019 — realm and user
  pool stay single and shared; assignment stays membership, not ownership.
- **Breaking:** the admin/MCP/seed/console surfaces move a level up — create an application, then add
  credentials under it; assignments + invites take `applicationId`; the role catalogue lives on the
  application; the `POST /admin/v1/clients` shape changes (a credential now needs an `applicationId`).
- **Watch — grouping is a judgment call.** Folding today's separate clients into applications cannot be
  fully inferred (a product runtime's `aud` is maestro's, not its product's), so the migration PROPOSES a
  grouping from client ids/subjects and an operator confirms it before it runs.

## Migration

`scripts/migrate-application-aggregate.ts` (idempotent; `--dry-run` PROPOSES the grouping and writes
nothing):
1. **Propose applications** by grouping credentials on a product key derived from client id / `subject`
   domain (e.g. `coach-web` + `skills-coach-ds1` → application `coach`), and print the mapping for operator
   confirmation.
2. **Create applications**, moving each group's role catalogue (union) and a default audience (the
   user-login credential's audience) onto the application.
3. **Set `applicationId`** on every credential; keep a per-credential `audience` override where it differs
   from the application default (product runtimes → `maestro-workspace`).
4. **Re-key** `assignments` and `invites` from `clientId` to `applicationId`.
5. **Operator safeguard (unconditional):** ensure an `identity-console` application with `platform_admin`
   in its catalogue, the identity-console credential under it, and admin@identity-service.fps4.nl holding an
   active assignment to that application. The workflow's verify step fails if that assignment is missing.
