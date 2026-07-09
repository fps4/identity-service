---
title: identity-service overview
summary: The product landing for identity-service — a standalone single-realm-per-deployment IdP issuing verifiable JWTs, with a management plane and an admin console.
status: current
last_updated: 2026-07-09
owners: [architect]
related:
  - README.md
  - docs/design/architecture.md
  - docs/reference/api.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
---

# identity-service

identity-service is a standalone identity service (a self-hosted IdP; one deployment = one realm with a single shared user pool — [ADR-0018](design/decisions/0018-collapse-tenant-into-deployment.md)) shared across products: a TypeScript service, a headless SDK, and an optional drop-in React `<Login/>`. It owns **authentication** (who you are) only — it issues RS256-signed JWTs verifiable through a published JWKS, and each consuming product keeps its own **authorization** (what you may do). It mints two token kinds: **machine tokens** (OAuth `client_credentials`) and **user identity tokens** (Google SSO via OIDC+PKCE *or* a local email/password IdP — a deployment-wide toggle), with an optional **app-scoped** `roles` claim products map to their own permissions; user tokens are entitlement-gated by a per-application **assignment** ([ADR-0019](design/decisions/0019-application-assignments-and-app-roles.md)). Day-2 operations run on an authenticated **management plane** (ADR-0007): the `/admin/v1` HTTP API, an MCP server for agents, and an optional operator **admin console** — all over one audited, per-actor service layer, with nightly encrypted backups. **Status: active** — machine tokens, both user IdPs, refresh/revoke, seed provisioning, and the management plane are live. Start with the **Design** shelf for how it's built, the **Reference** shelf for the API and token contract, or the **Guides** shelf to configure a deployment. New here? Read [`CODEBASE.md`](../CODEBASE.md), then [`docs/design/architecture.md`](design/architecture.md).
