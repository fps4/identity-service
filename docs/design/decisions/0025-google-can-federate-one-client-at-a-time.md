---
title: "0025: Google can federate one client at a time"
summary: "A deployment's Google app moved every authorization-code client at once. GOOGLE_FEDERATED_CLIENTS names the ones that move, so one application can require Google without changing how another's people sign in."
status: accepted
last_updated: 2026-11-05
date: 2026-11-05
related:
  - ./0012-federated-identity-and-account-linking.md
  - ./0018-collapse-tenant-into-deployment.md
---

## Context

`/oauth2/authorize` chose its provider per deployment: with a Google app configured, every client's browser login went to Google. A realm can hold applications with different needs. One holding a household's finances wants a second factor, and Google's 2-Step Verification is the way to get it while this service has no MFA. Another's people may have addresses no Google account holds, and would simply be locked out.

## Decision

`GOOGLE_FEDERATED_CLIENTS` names the clients whose browser login goes to Google. **Empty means every client's, so nothing changes for a deployment that does not set it.** Set, the others keep the local form. The choice is made when the authorization starts and recorded on it (`idp`), as it was already, so the local form still refuses an authorization meant for Google. The password grant is untouched: it never went through this choice.

## Consequences

- **The Google app stays one per deployment** (ADR-0018). This only narrows who it serves.
- **A person with both still has two subjects** (ADR-0012): the local one for local clients and Google's for federated ones. Linking on a verified email and the entitlement gate work as they do today. A consumer moved to federation must follow its people by email.
- **This is not an MFA guarantee for the realm.** A federated client's people cannot get a token for that client with a password, but the same people's password still works for clients that stay local.
