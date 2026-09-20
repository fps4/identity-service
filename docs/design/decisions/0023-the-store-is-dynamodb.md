---
title: "0023: The store is DynamoDB (maestro ADR-0018)"
summary: "identity-service's data access moves from MongoDB/mongoose to one DynamoDB table per deployment, made and owned by the Terraform module and reached by a role — no database credential exists. The shared shape every maestro component uses: items keyed pk/sk under realm#<kind> or ws#<workspace>#<kind>, every item carrying its kind, two general indexes and a sparse pending index, TTL on expires_at. Every act is one TransactWriteItems; uniqueness is a conditional put where the value is the key and a unique item in the same transaction where it is not; the outbox's sequence is allocated on the condition the counter did not move, and an act that lost that race is run again from its reads. Every mongoose index maps to a key, an index or a unique item, listed here."
status: accepted
last_updated: 2026-09-20
date: 2026-09-20
related:
  - https://github.com/fps4/maestro/blob/main/docs/decisions/0018-dynamodb-is-the-mvp-database.md
  - https://github.com/fps4/maestro/blob/main/docs/decisions/0017-the-tenant-repository-runs-the-pipeline.md
  - ./0022-maestro-principal-ids-and-lifecycle-events.md
  - ./0008-drop-sops-db-is-system-of-record.md
  - ./0013-invite-code-gated-registration.md
  - ./0021-credentials-minted-not-seeded.md
  - ../architecture.md
  - ../../guides/deployment.md
---

## Context

maestro's [ADR-0018](https://github.com/fps4/maestro/blob/main/docs/decisions/0018-dynamodb-is-the-mvp-database.md)
makes DynamoDB the record store of every component: one table per component, on-demand, point-in-time
recovery on, created by the component's Terraform module and owned by it; nothing made by hand and no
database credential anywhere. The cost of the second vendor sat in the seam — a cluster in another
console, a credential Terraform could not create, a floor per cluster — and every component after this
one would have been written on MongoDB.

This service's store was mongoose throughout: thirteen models, six transactions, unique, sparse and TTL
indexes, and a standalone-server fallback that wrote the outbox *beside* the change where a replica set
was missing. The suite drove an in-memory stand-in for the models.

## Decision

**The store is one DynamoDB table per deployment**, the shape maestro fixes for every component. The
service is given a `Store` (`service/src/db/`) and nothing outside it builds a key, an expression or an
SDK command. The Terraform module makes the table (`terraform/table.tf`) and grants each function's role
the actions it needs on the table and its indexes; `MONGO_URI` leaves the module's `secrets`, and the
relay and the backup hold no secret at all.

### 1. Items

The table is keyed `pk`/`sk`, both strings. Every item carries `kind`, its item type: `application`,
`oauth_client`, `user`, `assignment`, `session`, `oauth_token`, `oauth_authorization`, `invite`,
`key_store`, `audit_log`, `principal`, `outbox`, `counter`, `unique`. Because `kind` is the item type on
every item, a principal's own kind — human, agent, workload — is held as `principal_kind` in the item and
is `kind` again on the document; nothing else collides.

An item is the document's own attributes (`models/`, `_id` and all — the API returns them unchanged)
plus the table's: the keys, the index keys where the kind has them, `expires_at` where it expires. A
`Date` is stored as its ISO string and revived on read by its name (`…At`, `lockedUntil`); the opaque
subtrees a caller owns (`meta`, `context`, `claims`, `body`) and the spine envelope's `snake_case`
timestamps stay strings (`db/codec.ts`).

### 2. Keys, indexes and the mapping of every mongoose index

This deployment is one realm and one workspace on maestro's record (`MAESTRO_WORKSPACE_ID`,
`ws-<realm>`; ADR-0022). The realm's own items live under `pk = realm#<kind>`, `sk = <id>`; the record's
— principals, the outbox, its counters — under `pk = ws#<workspace_id>#<kind>`. Two general indexes,
`gsi1` (`gsi1pk`/`gsi1sk`) and `gsi2` (`gsi2pk`/`gsi2sk`), and the sparse `pending` index
(`pending_pk`/`pending_sk`) that only an undelivered outbox item carries. A **unique item**
(`kind = unique`, `pk = realm#unique#<what>`, `sk = <value>`, `ref = <owner id>`) claims a value that
must be one of a kind and names its owner: written in the owner's transaction with
`attribute_not_exists`, it is both the constraint and the lookup, read with strong consistency.

| mongoose index (model) | now |
|---|---|
| `users.email` unique | `unique#email` / `<email>` → user id; `getByEmail` reads it, then the user |
| `users.identities.(provider, subject)` unique, partial | `unique#identity` / `<provider>#<subject>` → user id, one per linked identity; written on link, released on unlink and on delete |
| `users.principalId` unique, sparse | subsumed: the principal item's key *is* the id and its binding to the user is a unique item (below); `principalId` is set on the user once, conditionally (`attribute_not_exists`) |
| `users.status` | not an index: a filtered key query over `realm#user` (the console's counts of disabled and locked users) |
| `users.createdAt` (none, but queried) | `gsi2`: `realm#user` / `<createdAt>` — the registration rate limit's "how many in the last minute" |
| `oauth_clients.applicationId` | `gsi1`: `realm#oauth_client#application#<applicationId>` / `<client_id>` — an application's credentials |
| `oauth_clients.principalId` unique, sparse | as for users: the principal item and its binding |
| `assignments.(userId, applicationId)` unique | the key: `realm#assignment` / `<userId>#<applicationId>`; there is no separate assignment id any more |
| `assignments.userId` | the key prefix: `begins_with(sk, "<userId>#")` — a user's applications |
| `assignments.applicationId` | `gsi1`: `realm#assignment#application#<applicationId>` / `<userId>` — an application's members |
| `invites.codeDigest` unique | `unique#invite_code` / `<digest>` → invite id; redemption reads it, then the invite |
| `invites.applicationId` | dropped: nothing queried it |
| `oauth_tokens.hashedToken` (none, but queried) | `gsi1`: `realm#oauth_token#refresh` / `<hash>` — a refresh token by the hash of its value, then re-read from the table by id so a revocation a moment ago is seen |
| `oauth_tokens.(type, issuedAt)` | `gsi2`: `realm#oauth_token#<type>` / `<issuedAt>` — the rate limit's and the console's counts of access tokens issued since a moment; active refresh tokens are the same partition filtered on `status` |
| `oauth_tokens.(clientId, status)`, `.expiresAt`, `.status` | dropped: nothing queried them; expiry is the TTL |
| `oauth_authorizations.loginToken`, `.googleState`, `.code` | three unique items — `unique#authorization_login`, `unique#authorization_state`, `unique#authorization_code` / `<handle>` → authorization id — each written in the same transaction as the handle it names, so the exchange that follows a redirect within the second reads its own write; the status is checked on the document |
| `oauth_authorizations.expiresAt` TTL | the table's TTL on `expires_at`, on the authorization and its three unique items |
| `oauth_authorizations.clientId`, `.status` | dropped: nothing queried them |
| `sessions.status`, `.expiresAt` | dropped as indexes; a session is read by id and expires by the TTL |
| `key_store.kid` unique | the key: `realm#key_store` / `<kid>`; the few keys are read whole and filtered in code |
| `audit_logs.at`, `.principalClientId` | the key: `realm#audit_log` / `<uuidv7>` — time-ordered, so "the latest N" is one reverse key query; the principal index is dropped, nothing queried it |
| `principals.(subjectType, subjectId)` unique | `ws#<ws>#unique#principal_subject` / `<subjectType>#<subjectId>` → principal id, written in the registration's transaction and read by the backfill |
| `outbox.(workspace_id, seq)` unique | the key: `ws#<ws>#outbox` / `<seq, zero-padded to 12>` — a double allocation is a failed condition, never a silent gap; `event_id` is unique by construction (a UUIDv7 minted inside the transaction) and has no item of its own |
| `outbox.(delivered, workspace_id, seq)` | the sparse `pending` index: `pending_pk = ws#<ws>#outbox`, `pending_sk = <seq, padded>`, set while undelivered; acknowledging removes both |
| `counters._id` | the key: `ws#<ws>#counter` / `outbox` (the workspace sequence, attribute `value`) and `/ subject#<prn>` (a principal's) |

A key read (`GetItem`, `BatchGetItem`, a `Query` on the table) is **strongly consistent**; a read from an
index is **eventually consistent**, and every index read here tolerates that: a listing, a count, the
relay's batch (the archive's append is exactly-once by `(workspace, seq)`, so a re-read after an
acknowledgement is skipped there), and a refresh token that is re-read from the table by its id after
the index found it. Every lookup that a correctness rule depends on — an email, an identity, a code, a
login handle, a principal's binding — goes through a unique item, and is strongly consistent.

### 3. Every act is one transaction

`withRecordTransaction(store, fn)` gives the act a `Transaction`; the act reads what it needs and adds
its writes with the conditions that say what it read is still true; the recorder adds the outbox items
and advances the counters (`value = :expected`, or `attribute_not_exists` for a first event); the commit
is one `TransactWriteItems`. The change and its record land together or not at all — the
standalone-server fallback of ADR-0022 is gone, because DynamoDB transactions always exist.

Two acts racing on one workspace serialise on the counter: the second's condition fails, and it is run
again from its reads, up to six times with a short backoff. A caller's own failed condition — an email
taken, an id in use, an invite spent — is never retried; it is the caller's answer (`ConditionFailed`
naming the write's label), mapped to the same `409` or `403` the pre-checks give.

Two consequences of DynamoDB's rules shape the code:

- **A transaction touches an item once.** A principal backfilled for a record that predates the
  registry (ADR-0022) is its own committed transaction *before* the act's, because the act may write the
  same user again (a deletion, a status change). The backfill mints only and emits nothing, so an act
  that fails after it leaves nothing wrong behind.
- **A transaction holds at most a hundred writes.** Deleting a user or an application revokes every
  seat its assignments conferred, one transaction per assignment, then the deletion itself; each step is
  atomic, the counter serialises them, the events chain by `causation_id` to the first of the act, and a
  run cut short leaves the rest to the next call.

An invite is redeemed *inside* the registration's transaction (a conditional decrement on
`usesRemaining`, expiry and revocation), so a registration refused later in that transaction — the email
taken — never took the use; the refund logic of ADR-0013 is gone with the reason for it.

### 4. Expiry

The table's TTL is on `expires_at` (epoch seconds): an authorization and its handles at the
authorization's expiry, as the mongoose TTL swept them; a session at its expiry; a token a day *after*
its expiry, so the console's count of the day's issuance stays whole. An invite carries no `expires_at`:
the console lists an expired invite as expired, as before. DynamoDB sweeps within days of the moment,
never before it; every read checks `expiresAt` itself, as it did.

### 5. Configuration, the shape check, and the size of an item

The service reads `TABLE_NAME` (required), `DYNAMODB_ENDPOINT` (DynamoDB Local; unset in a deployment)
and `AWS_REGION`. At boot `Store.connect` describes the table and refuses one whose key schema or
indexes are not what `service/src/db/table.ts` declares — the one schema in code, which the tests and
the compose loop create their tables from and `tests/store.test.ts` holds `terraform/table.tf` to. A
TTL that is off is a warning at boot, not a refusal.

An item is at most 400 KB. The largest here are a signing key (an RSA-4096 private key, encrypted as
hex, under 20 KB) and an audit entry (its `meta` a handful of ids and role keys, under 5 KB);
`tests/store.test.ts` measures both. An outbox item is a spine envelope with a token-only body. Nothing
stores a blob.

### 6. Tests, the loop, the backup

The suite runs against DynamoDB Local (`amazon/dynamodb-local`, `-sharedDb -inMemory`), each test file
on a table of its own (`tests/helpers/store.ts`); the DoD job runs the container as a service. The
compose stack runs the same image with its data on a volume, makes the table from the schema in code,
then the service. The backup Lambda pages the whole table (`Scan`, the one grant only it has) into
gzipped canonical JSON lines on S3, one file per kind, optionally encrypted as before;
`backup:restore` is a `PutItem` per line; point-in-time recovery is the second line.

## Consequences

- No database credential exists. `MONGO_URI`, `MONGO_DB_NAME` and every Mongo setting are gone from the
  configuration, the compose stack, the module and the docs; `mongoose` is gone from the dependencies.
- Access patterns are designed, not discovered: every query is a key, an index or a unique item, and a
  new pattern is a change to `table.ts` and `table.tf` together, reviewed in a plan. The service never
  scans.
- Uniqueness and the outbox's order are now transactional facts rather than index side effects, and
  the record is never "written beside" a change.
- The three one-shot Mongo migrations of ADR-0019/0020 and the ds1 rename cutover, the compose stack's
  `mongodump` script and the `manage-users set-roles` command (which wrote a field ADR-0019 removed) are
  retired with the database they operated on; their history is in git.
- An assignment has no id of its own any more; the pair is the key. The API never returned one.
- A listing sorted in memory (invites, signing keys) reads its whole partition: bounded by the realm,
  adequate for an identity service; a realm that outgrows it adds an index.

## When to revisit

An access pattern the indexes cannot serve at cost; a realm whose users or audit trail outgrow a
partition's read; an item that approaches the size limit; or maestro reopening ADR-0018.
