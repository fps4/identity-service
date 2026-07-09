---
title: Resource-Server Integration Guide
summary: The build-once contract for a product consuming identity-service — verify the token, map its app-scoped roles to capabilities, and enforce locally.
status: current
last_updated: 2026-06-23
owners: [architect]
related:
  - docs/design/decisions/0005-decentralized-authorization.md
  - docs/design/decisions/0019-application-assignments-and-app-roles.md
  - docs/design/decisions/0020-application-aggregate.md
  - docs/product/RQ-0005-user-roles-in-identity-token.md
  - docs/reference/api.md
  - docs/guides/tenant-config.md
---

# Resource-Server Integration Guide

How a product integrates with identity-service. This is the build-once contract every consuming
product follows, so that authentication is owned in one place and authorization stays local to
each product.

identity-service is the **authentication engine** (an OAuth2/OIDC Identity Provider). Each product
is a **resource server**: it verifies the token identity-service issues and makes its own
authorization decisions. The decision behind this split is [ADR-0005 — decentralized
authorization](../design/decisions/0005-decentralized-authorization.md); the roles mechanism is
[RQ-0005](../product/RQ-0005-user-roles-in-identity-token.md), now **app-scoped** under
[ADR-0019](../design/decisions/0019-application-assignments-and-app-roles.md) — the `roles` claim carries
the user's roles *in this application* (the token's `aud`), sourced from their assignment. This guide is
the *how-to* for the consuming side; from a resource server's view the contract is unchanged — you read
`roles` exactly as before, they simply already mean "this user's roles in **this** app."

## The split: who owns what

| Concern | Owner | Where it lives |
|---|---|---|
| Login, credentials, password reset, Google SSO | **identity-service** | the IdP |
| Users, the user store, JWKS, token issuance | **identity-service** | the IdP |
| **App-scoped role assignment** ("alice is a `reviewer` *in this app*") | **identity-service** | the `roles` claim on the signed token; from the user's per-application assignment (ADR-0019) |
| **Entitlement** ("alice may use this app at all") | **identity-service** | the assignment gate — no active assignment ⇒ no token issued (ADR-0019) |
| **Token verification** (signature, `iss`/`aud`/`exp`) | **the product** | a verifier at the product's edge |
| **Fine-grained role → capability mapping** ("`reviewer` may approve a filing") | **the product** | the product's own config/code |
| **Enforcement** of capabilities on operations | **the product** | the product's request path |
| **User / role administration UI** | **identity-service** | build-once; serves all products |

The governing rule: **identity-service asserts identity and app-scoped roles (and gates entitlement at
issuance); it never enforces what a role may do.** Each product maps the role strings it receives to its
own permissions. (ADR-0005, RQ-0005 scope §5; ADR-0019 for the app-scoping and the entitlement gate.)

## What identity-service gives you

- **A verifiable RS256 identity token** with `sub` (stable), `email`, `iss`, an `aud` (your **application's**
  audience, or a credential override — ADR-0020), `exp`/`iat`, and an **optional `roles` claim** — the user's
  **app-scoped** roles for that `aud` (omitted when the assignment grants none). Because issuance is
  entitlement-gated (ADR-0019), a token only exists for a user assigned to your app. See
  [`reference/api.md`](../reference/api.md) for the exact contract.
- **JWKS** at `/.well-known/jwks.json` for signature verification.
- **OAuth2 endpoints** — `/oauth2/token` (local password grant) and authorization-code + PKCE
  (Google SSO).
- **A login widget** — the `@fps4/identity-service-react` `<Login/>` component.
- **Operator entitlement & role provisioning** — per-application **assignments** (`POST /admin/v1/assignments`,
  the console, or the seed's per-user `assignments:`), drawing roles from each application's **role
  catalogue** (ADR-0019; see [deployment configuration](./tenant-config.md)).

## What your product owns

1. **Verify the token at the edge** — signature against the JWKS, and `iss` / `aud` / `exp`.
   Extract `sub`, `email`, and `roles`.
2. **Stay stateless on identity** — do **not** keep a user table or a role-grant store, and do
   **not** call back to identity-service to make an authorization decision. Everything you need
   arrives on the verified token.
3. **Map your app's roles → your capabilities in your own config** — a role string like `reviewer`
   means whatever your product's capability map says it means. Keep that map in the product repo. The
   role strings are your application's catalogue (ADR-0019), so they are already scoped to you.
4. **Enforce** those capabilities on your protected operations, returning a uniform `403` when the
   caller's roles don't grant the required capability.
5. **Default safely** — a role you don't recognise maps to **no capabilities** (deny by omission);
   log it. An absent `roles` claim means the user is assigned to your app with no roles — pick a
   documented default (e.g. a baseline role) rather than failing closed silently.

## Roles are app-scoped (ADR-0019)

Since [ADR-0019](../design/decisions/0019-application-assignments-and-app-roles.md) the `roles` claim is
**per-application**: it carries the user's roles in the token's `aud` application, drawn from that
application's own **role catalogue** via their assignment. Two products sharing the deployment no longer
see the same flat role array — each receives only its own app's roles, so **role-string namespacing is no
longer needed**. Your product's role vocabulary is simply its application's catalogue (managed in
identity-service).

An unknown role still → no capabilities (logged); default safely. An absent `roles` claim means the user
is assigned to your app but granted no roles — pick a documented default (e.g. a baseline role) rather
than failing closed silently.

## Admin UI is identity-service's job — build once

User and role administration (create user, reset password, lock, **assign roles**) is
identity-service data and belongs inside its security boundary. **Products do not build their own
user-management surfaces** — that would duplicate the same admin UI over the same data N times.
Provisioning is available three ways over one audited service layer (ADR-0007): the `manage-users`
CLI, the authenticated [`/admin/v1` HTTP API](../reference/api.md#admin-v1-management-plane) (with an
MCP server for agents), and the operator [admin console](../../console/README.md) — all
identity-service deliverables that serve every product. A product may own **only** a *read-only*
view of its own role → capability mapping (it mutates nothing and owns no identity).

## Integrate via the verifier-SDK pattern, not bespoke code

Don't re-implement JWKS handling per product. The integration surface is:

- A **per-language token verifier** — JWKS fetch + cache, signature + `iss`/`aud`/`exp`
  enforcement, claim extraction. *Reference implementation:* sovereign-copilot's
  `src/chat_api/edgeauth.py` (Python). Promote shared verifiers into versioned libraries as more
  products integrate.
- The **`<Login/>` widget** for the frontend.

## Operational notes

- **Adding roles and access is operator config, not code.** Define your app's role **catalogue** on the
  **application** (ADR-0020), then **assign** users to the app with roles (`POST /admin/v1/assignments` or the console — ADR-0019).
  The catalogue, assignments, and the admin surface already ship — no identity-service code change is
  needed to light up RBAC in a consuming product.
- **Role and entitlement changes have a refresh-window latency.** The assignment is re-read at each token
  issuance (including refresh), so a role change — or a revoked/suspended assignment, which then denies
  refresh — takes effect no later than the next access-token refresh. For instant revocation you'd add
  token introspection or shorter TTLs — defer until a deployment requires it.

## Worked example: sovereign-copilot

sovereign-copilot is a resource server consuming this contract. Its edge verifier is
`src/chat_api/edgeauth.py` / `require_identity()`; it owns no user store; its role → capability map
and enforcement (`require_capability`) live in the copilot repo. Its instance of this decision is
sovereign-copilot ADR-0015 (*identity-service as authentication engine; copilot as resource server*),
implemented by copilot story US-0109.
