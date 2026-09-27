---
title: "0024: A person's preferences live on their profile (maestro ADR-0029)"
summary: "A person keeps one small preferences document per application on their profile: GET and PUT /v1/me/preferences/<application>, called with their own access token for their own document only, stored as realm#preferences / <userId>#<applicationId>. At most 8 KB, replaced on write, opaque to this service. A preference authorises nothing, is not an act on the registry and so is not recorded on maestro's spine, and is not shown in the admin console."
status: accepted
last_updated: 2026-09-27
date: 2026-09-27
related:
  - https://github.com/fps4/maestro/blob/main/docs/decisions/0029-a-persons-preferences-live-on-their-profile.md
  - ./0005-decentralized-authorization.md
  - ./0022-maestro-principal-ids-and-lifecycle-events.md
  - ./0023-the-store-is-dynamodb.md
---

## Context

maestro's console remembers a person's last choice of filters, on any browser they sign in from
([maestro ADR-0029](https://github.com/fps4/maestro/blob/main/docs/decisions/0029-a-persons-preferences-live-on-their-profile.md)).
It holds no data of its own, and the person is this service's: their profile is here. Nothing here stored
anything a person chose for themselves beyond their credential.

## Decision

- **Two routes, the person's own.**
  - `GET /v1/me/preferences/<application>` returns the stored object, or `{}`.
  - `PUT /v1/me/preferences/<application>` replaces it.
- **The caller is the person, by their token.** It is any access token this service issued for a user, verified against this service's own JWKS and `iss`.
  - A local login's `sub` is the user's id; a federated login's `sub` is resolved through the user's linked identity.
  - A machine token (`cid`) names no person and is refused (403), as is an unknown or disabled user.
  - There is no route to anyone else's document, not for an operator either.
- **Namespaced per application.** `<application>` must be an application of the realm (404 otherwise). One application's document is nothing to another's.
- **Small and opaque.**
  - A JSON object of at most 8 KB (400 if not an object, 413 if larger), replaced whole on `PUT`, with `updatedAt`.
  - Stored as `realm#preferences` / `<userId>#<applicationId>`.
  - This service never reads inside it: `preferences` is an opaque subtree in the codec, so its strings stay strings.
- **Not the registry.** A preference authorises nothing ([ADR-0005](./0005-decentralized-authorization.md)) and is not an act on users, credentials or assignments. So it is written outside the record ([ADR-0022](./0022-maestro-principal-ids-and-lifecycle-events.md)) and not in the admin console.
- **One verifier.** The own-token verification the admin plane used (`core/own-token.ts`) is shared by the admin layer and `/v1/me`.

## Consequences

- One new item kind in the table, reached by key. There is no index and no table change.
- A backup carries preferences with every other item. A disabled user's preferences stay until the user is deleted.
