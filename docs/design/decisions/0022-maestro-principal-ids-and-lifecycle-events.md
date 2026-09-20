---
title: "0022: identity-service mints maestro principal ids and emits its lifecycle to the spine"
summary: "Every user and every machine credential gets a stable maestro principal id (prn-h-… / prn-a-… / prn-w-…) minted here and carried in every token as the `prn` claim. The registry emits PrincipalRegistered, PrincipalSuspended, PrincipalReinstated and SeatOccupancyChanged as maestro spine envelopes through a transactional outbox, attributed at the act — a human answers for their own act at O0; a machine answers to the deployment's configured accountable human — and a relay carries them into maestro's archive. An application's role is the seat; an assignment is its occupancy. Consumers may stop minting ids of their own."
status: accepted
last_updated: 2026-09-20
date: 2026-09-20
related:
  - ./0019-application-assignments-and-app-roles.md
  - ./0020-application-aggregate.md
  - ./0021-credentials-minted-not-seeded.md
  - ./0012-federated-identity-and-account-linking.md
  - ./0010-console-operator-authentication.md
  - ./0018-collapse-tenant-into-deployment.md
  - https://github.com/fps4/maestro/blob/main/docs/components/identity-service.md
  - https://github.com/fps4/maestro/blob/main/docs/components/spine.md
  - https://github.com/fps4/maestro/blob/main/docs/governance-model.md
  - https://github.com/fps4/maestro-specs/blob/main/docs/design/decisions/0019-the-outbox-holds-spine-envelopes.md
---

## Context

maestro's design names this service as **the principal registry**: the place every component resolves a
token to a maestro **principal** — a human, an agent (an AI process acting under a human's
accountability), or a workload (a deployed service acting for itself) — and the rule that *no maestro
record ever stores an identity provider's subject*. Every event on maestro's **spine** carries four
attribution fields (`accountable`, `acting`, `seat`, `oversight_level`); `accountable` must resolve to a
human principal in the registry, and every principal reference must be a maestro principal id whose
shape carries the kind: `prn-h-…`, `prn-a-…`, `prn-w-…`. maestro's M1 asks this service for one change:
*principal lifecycle events — `PrincipalRegistered`, `PrincipalSuspended`, `SeatOccupancyChanged` —
emitted by the registry to the spine*.

Until now the registry lived in each consumer. maestro-specs (its ADR-0019) mints a principal id on the
first sight of an `(issuer, subject)` pair and keeps the mapping in its own control database, and it
reads a `principal_kind` claim from our machine tokens to tell an agent from a service. That is one
registry per consumer, each with its own ids for the same person, and none of them learns that a user
was disabled or a role revoked until the next token arrives — the opposite of "demotion takes effect on
the next act, not the next token refresh".

This service already has everything a registry needs: the user pool, the machine credentials, the
per-application role catalogues and assignments (ADR-0019/0020), the operator-vs-machine distinction on
the management plane (ADR-0007/0010), and an append-only audit log. What it lacks is a maestro id per
principal, and a way to say out loud — in maestro's envelope, under maestro's rules — when a principal
comes, goes, or changes seats.

## Decision

### 1. Every principal has a maestro id, minted here

A **user** is a `human` principal. A **`client_credentials` credential** is a machine principal: an
`agent` when it declares `claims.principal_kind: agent` (what an AI runtime's credential already carries
for maestro-specs), otherwise a `workload`. A user-login credential (`password`, `authorization_code`)
authenticates people and is not a principal.

The id is `prn-<h|a|w>-<12 lower-case Crockford base32>` — the spine's grammar, and the same shape
maestro-specs minted meanwhile so nothing minted there needs rewriting. It is persisted on the record
(`users.principalId`, `oauth_clients.principalId`) and in a **`principals` registry collection**
(`_id`, `kind`, `status`, what it binds to). Minted at creation; for a pool that predates this ADR,
**backfilled on first use** — a token issuance, a management-plane act — idempotently and safely under a
race. A backfill mints only: it emits no `PrincipalRegistered`, because the registration it would describe
happened before there was a record to hold it (see *Interim*).

**The registry row outlives what it binds to.** Deleting a user or a credential *retires* its principal
(`status: retired`) and never removes it, because the archive already names the id and the relay must
still be able to say what kind of thing acted.

### 2. The token carries `prn`

Every token this service mints carries **`prn`** — the principal id of the human (user tokens) or the
credential (`client_credentials` tokens) — beside the claims consumers read today. `sub` is **unchanged**:
a user id for a local login, the provider's subject for a federated one (ADR-0012's contract), the
credential's `subject` for a machine. `principal_kind` is kept: `human` on every user token; on a machine
token the credential's own declaration passes through, and a machine credential that declares none gets
`workload`. `prn` is what a consumer's registry should key on from now; `principal_kind` is how a consumer
that has not yet moved still tells an agent from a human. Nothing about oversight level is a claim.

### 3. Four types, bodies of tokens only

| Type | When | Body |
|---|---|---|
| `PrincipalRegistered@1` | a user is created (operator, self-service, first Google login, seed); a machine credential is created | `{ kind: human\|agent\|workload, source: local\|google\|client_credentials\|seed, realm }` |
| `PrincipalSuspended@1` | a user is disabled; a user or a credential is deleted | `{ reason: disabled\|locked\|deleted }` |
| `PrincipalReinstated@1` | a disabled or locked user is re-enabled or unlocked | `{ reason: enabled\|unlocked }` |
| `SeatOccupancyChanged@1` | a role is granted to or revoked from a principal on an application | `{ seat, application, change: granted\|revoked, oversight_level }` |

`PrincipalReinstated` is this service's addition to maestro's three: the model has reactivation, and an
auditor reading a suspension should be able to read its end. Bodies are narrowed by per-type schemas
registered with the spine (`TypeSchemas`, keyed `Type@1`); the spine's floor forbids anything that reads
as prose, and a role key or an application id that is not a token is refused when the catalogue or the
application is created, so a grant can always be recorded. No name, email, subject or client id is in any
body; `realm` is the workspace slug.

**The seat is the application's role; the occupancy is the assignment.** An application's role catalogue
(ADR-0019/0020) is a closed vocabulary of tokens stamped into the `roles` claim — exactly what maestro
calls a **seat**: a role in a process a principal occupies. A user's assignment to an application, with
its roles, is the occupancy. One `SeatOccupancyChanged` per role that changes hands: a new assignment
grants each role; a role change grants the new and revokes the old; suspending an assignment revokes
every role and reactivating grants them back; revoking or deleting revokes every role. An unchanged
re-assignment records nothing. For a machine credential the roles it declares in `claims.roles` are its
seats, granted at creation and revoked at deletion.

**Oversight level in the body** is the level the seat operates at. This service has no per-seat level yet
(see *Interim*): a human's seat is `O0`, a machine's `O1`.

### 4. Attribution: who acts, who answers

Every act is attributed at the act, from the actor alone, and copied on:

- **A human** — an operator on the management plane (ADR-0010), a person registering or signing in for
  the first time — answers for their own act: `accountable = acting`, `oversight_level: O0`.
- **A machine** — an agent over the MCP, a workload with an admin credential — answers to the human the
  deployment names as accountable for its automation: **`MAESTRO_ACCOUNTABLE`**, the `prn-h-…` of a user
  in this pool. There is **no default**: without it a machine actor **cannot act** — the act is refused
  (`403`) before anything is written, and the refusal is logged. A machine's act carries `O4`: it acted
  alone and the answerable human reads the trail afterwards, which is what "agent acts, human notified"
  means. Recording `O0` there would claim a human was in the loop who was not.
- **`seat`** on the envelope is the seat the act was performed *from*: `operator` for the management plane
  and the seed, `self` for self-service (registration, first federated login, an invite's roles landing on
  the redeemer). It is not the seat whose occupancy changed — that is in the body.
- The **seed** is an operator's act: `npm run seed -- --as=<email>` names the person (default: the first
  user in the file). If the file introduces them, their own registration — by themselves, `source: seed` —
  is the run's first event, so a fresh realm's record begins with its operator.
- `consequence_class` is `MAESTRO_CONSEQUENCE_CLASS`, `c1` by default. `correlation_id` is one per
  request (minted at the edge); events of one act chain by `causation_id` to the first of them.

### 5. The outbox and the relay

The outbox row **is** the spine envelope plus three bookkeeping fields (`delivered`, `delivered_at`,
`attempts`). `emit()` builds it, validates it with the spine's own `assertEvent` against the registry, and
inserts it **in the same transaction** as the change — `seq` from a per-workspace counter and
`subject_seq` per principal, both allocated there. **An act the spine would refuse is not performed**: the
recorder throws, the transaction aborts, the caller gets the reason.

This deployment is one realm (ADR-0018), so one workspace on maestro's record: **`MAESTRO_WORKSPACE_ID`**
(`ws-<realm slug>`; `ws-identity-dev` in development). A tenant sets its own from `maestro-config-<tenant>`.

MongoDB transactions need a replica set (Atlas Flex is one; the compose loop's `mongod` is not). The
transaction is a capability probe made once: on a standalone server the outbox row is written *beside*
the change rather than atomically with it, and the service says so at boot. Attribution is settled before
the transaction opens, so a refused machine actor never writes anything, transaction or not.

The relay is the spine's: `OutboxSource` over the `outbox` collection, resolving principals for the
relay's own check from the `principals` collection (a retired principal still resolves). **`RECORD_SINK`**
is maestro-specs' contract, so one tenant module configures every component alike: `local` (default)
relays on an interval inside the service into `RECORD_ARCHIVE_DIR` (`./archive`) with in-process
delivery — a laptop's spine, readable by `spine-verify` with everything off; `s3` into `ARCHIVE_BUCKET` /
`ARCHIVE_PREFIX` / `EVENTS_TOPIC_ARN`, the spine module's outputs; `off` writes the outbox and leaves it
to the scheduled Lambda (`service/src/relay/lambda.ts`, `relayHandler({ component: 'identity' })`) that
the Terraform module deploys. A refused event stops its workspace where it stands and is logged on every
pass; relay lag is the alarm.

## Consequences

- **Consumers may stop minting.** maestro-specs' registry can key on `prn` and stop keeping an
  `(issuer, subject)` mapping of its own; its `PrincipalDirectory` becomes a projection of this service's
  events. That is their change, not this one.
- **Tokens carry `prn`** and `principal_kind`; `sub`, `email`, `roles`, `aud` are unchanged. Every existing
  verifier keeps working; a verifier that ignores `prn` is unaffected.
- **The record and the pool cannot disagree on attribution**, because attribution is fixed in the
  transaction that made the change; there is no relay-time lookup to drift.
- **The `principals` collection is the registry maestro's design describes**, minus the multi-issuer
  bindings and the enumeration endpoint (M2). Dropping a consumer's projection and rebuilding it from the
  archive is what the events are shaped for: a principal's stream is registration, seats, suspensions.
- **A machine actor needs a named human.** A deployment whose agents or pipelines act through the
  management plane must set `MAESTRO_ACCOUNTABLE`, or those acts are refused. That is the point: an agent
  with no answerable human does not act on a registry.
- **Role keys and application ids are tokens.** A catalogue role or an application id with a space in it
  is refused at creation (`400 invalid_input`). Every existing catalogue in this repository's tests and
  seeds already complies.
- **The seed names its operator.** `npm run seed` attributes its acts to `--as=<email>` / `SEED_AS` /
  the file's first user, and emits only what changed on a re-run.
- The service depends on `@fps4/maestro-spine` (the envelope, the rules, the relay) and `zod` (the body
  schemas). The spine is the one package whose rules we must not paraphrase.

## Interim — what this ADR does not settle

- **No per-seat oversight level.** The registry does not yet carry a level per seat, so
  `SeatOccupancyChanged` says `O0` for a human's seat and `O1` for a machine's, and a machine's act on the
  operator seat is recorded at `O4`. When seat occupancy carries a level (maestro M2), both are read from
  there and a demotion takes effect on the next act.
- **A backfill does not register.** Principals that predate this ADR receive an id on first use and no
  `PrincipalRegistered`; the archive first sees them as the subject of a later event. maestro's M2
  enumeration endpoint is how a consumer reconciles them. A deployment that wants a complete record may
  re-register from a seed run.
- **Brute-force lockouts are not events.** A temporary `lockedUntil` set after failed logins is a
  transient guard, not a commitment change ("an event per commitment change, never per keystroke"); an
  operator's `disable` is. `locked` remains a valid suspension reason for the model's `status: locked`.
- **Identity linking is not an event.** Linking or unlinking a Google identity onto a user changes a
  binding, not the principal; the registry's `bindings` are M2.
- **The operator CLI bypasses the record.** `scripts/manage-users.ts` writes users directly and predates
  ADR-0019; the management plane, the seed and self-service are the recorded paths. It should be retired
  or routed through the admin service.
- **One `principal_kind` vocabulary.** maestro says `workload`; maestro-specs' verifier still reads
  `service`. A credential's declared claim passes through unchanged, so nothing breaks; `prn`'s letter is
  the authoritative kind.

## When to revisit

When the registry carries seat occupancy with a level per seat — read the level from there. When
identity-service is asked for the enumeration endpoint (M2) — the same `principals` collection serves it.
When a consumer keys on `prn` — nothing here changes; retire `principal_kind` only once none reads it.
