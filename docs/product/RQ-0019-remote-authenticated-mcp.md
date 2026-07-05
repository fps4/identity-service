---
title: "RQ-0019 — Remote, OAuth-authenticated MCP management service (no SSH)"
status: in-progress
last_updated: 2026-07-05
owners: [architect]
related:
  - docs/design/decisions/0009-remote-authenticated-mcp-service.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
  - docs/design/decisions/0011-identity-data-operating-model-and-mcp-scope.md
  - docs/design/decisions/0017-product-runtime-self-registration-invites.md
  - docs/product/RQ-0009-console-api-parity.md
  - docs/reference/api.md
  - docs/guides/deployment.md
maestro:
  feature: remote-authenticated-mcp
  kind: functional_spec
  summary: |
    Make the identity-service management MCP server reachable remotely over the network with the standard
    MCP OAuth flow, instead of only via SSH + stdio (`ssh ds1 docker/mcp-admin.sh`). An MCP client connects
    to an HTTPS endpoint, authenticates with an admin-scoped token minted by identity-service (its own
    authorization server), and calls the same read+operational tools — verified through the same admin-auth
    + audit path. No shell account on the production host, no dropped SSH tunnels. Delivered in phases:
    Phase 0 splits the server into a transport-agnostic core + a thin stdio transport; Phase 1 adds the
    in-process Streamable HTTP transport as an OAuth 2.1 protected resource; Phase 2 hardens it (dedicated
    origin, audience-binding, sender-constraint, step-up, dynamic client registration). stdio-over-SSH stays
    as documented break-glass.
---

# RQ-0019 — Remote, OAuth-authenticated MCP management service

- **Status:** in-progress — Phases 0, 1, and the audience-binding + origin + Origin-check parts of Phase 2
  are delivered and live; the remaining Phase 2 hardening is backlog (see below).
- **Raised:** 2026-07-05
- **Owner:** @farid (architect)
- **Decision:** [ADR-0009](../design/decisions/0009-remote-authenticated-mcp-service.md) — Streamable HTTP
  transport, dedicated resource origin, identity-service as its own authorization server, sender-constrained
  tokens, and the phased rollout.

## Delivery status

**Done (in production, live-verified):** Phase 0 transport-agnostic core (#66); Phase 1 Streamable HTTP
transport + OAuth discovery (#67); Phase 2 dedicated `auth-mcp.fps4.nl` origin (#68/#69), audience-binding
RFC 8707 (#68), and `/mcp` Origin/DNS-rebinding allow-list (#70); plus the `createClient` `claims` enabler
(#66). An agent now connects to `https://auth-mcp.fps4.nl/mcp` with a resource-bound admin bearer — no SSH.

**Backlog (deferred, not blocking — tracked here + in the ADR-0009 delivery-status table):** DPoP/mTLS
sender-constraint; step-up assurance on the riskiest tools; gated dynamic client registration (RFC 7591);
browser-client `Origin` allow-listing (`MCP_ALLOWED_ORIGINS`); and the cross-repo maestro contracts. These
chiefly benefit interactive/browser clients or add sender-constraint; the current posture (audience-bound
bearer + Origin allow-list + per-tool scope + audit, isolated origin) is a reasonable bar for the
machine/agent consumers in use today. `stdio`-over-SSH remains the documented break-glass path.

## Why

The management MCP server (ADR-0007) is the agent face of the management plane, but it ships **stdio-only**
and the only remote path is the SSH wrapper `ssh ds1 docker/mcp-admin.sh`, which `docker exec`s the server
inside the container and streams JSON-RPC over the SSH pipe. That transport is the limitation:

- **Not reachable off the box's network**, and every operator/agent needs an **SSH account + `docker exec`
  on a production host** — a far larger grant than "call these eleven admin tools."
- **AuthN is host-level, not protocol-level:** SSH gates who reaches the box; the caller never proves an
  identity to the MCP server. There is no per-client credential and no flow off-the-shelf MCP clients speak.
- **It is fragile.** During the 2026-07-04 ds1 fleet-telemetry work the SSH tunnel dropped on idle and
  stranded the management plane mid-task — the concrete failure that motivated raising this now.

identity-service is *itself* an OAuth authorization server (it runs `/oauth2/*`, signs RS256, publishes
JWKS), which is exactly what the MCP authorization spec needs in front of a remote MCP resource. So we make
identity-service the authorization server for its own MCP resource and add a network-reachable transport —
without a second IdP, and keeping ADR-0007's invariant of one authorization model and one audit trail.

**Story.** *As an operator or agent, I want to connect to the identity-service management MCP over HTTPS
with a normal MCP OAuth login and call the admin tools, so I don't need a shell account on the production
host and my session doesn't die when an SSH tunnel times out.*

## Scope

1. **Phase 0 — transport-agnostic core (no behaviour change).** Split `service/src/mcp/server.ts` into a
   transport-agnostic JSON-RPC/tool handler (`initialize`, `tools/list`, `tools/call`, `ping`, the tool
   catalogue, and the `principalHasScope` gate + audit) and a thin **stdio** transport over it. Handler-level
   tests. No new endpoint, no protocol change — this only unblocks a second transport.
2. **Phase 1 — MVP remote transport.** Add the MCP **Streamable HTTP** transport in-process on the existing
   Express app (the one serving `/oauth2`, `/admin/v1`, `/.well-known/jwks.json` on :7305): one endpoint
   handling `POST` (JSON-RPC, optional SSE) + `GET` (SSE). It is an **OAuth 2.1 protected resource** — the
   client presents an admin-scoped bearer minted from the service's own `/oauth2` (`client_credentials` for
   agents, `authorization_code`+PKCE for humans), verified by the same `verifyAdminToken` + scope gate.
   Publish `/.well-known/oauth-protected-resource` so standard clients auto-discover the AS. Swap the client
   config from `ssh ds1 …` to the URL. **This is the deliverable that removes SSH.**
3. **Phase 2 — hardening** (ADR-0009, high-privilege on the public internet): dedicated resource origin
   `auth-mcp.fps4.nl`, audience-binding (RFC 8707), sender-constraint (DPoP / mTLS), role-derived scopes with
   a step-up assurance claim, gated dynamic client registration, and the maestro contracts (credential
   custody/DCR, audit emission, remediation scopes).
4. **Keep stdio-over-SSH** as the documented local/dev + break-glass path.
5. **Enabler — `createClient` accepts `claims`.** So product-runtime clients (`role: product_runtime`) can be
   created wholly through the management plane (HTTP `/admin/v1/clients`; and the MCP surface if/when
   structural creation is exposed), instead of a post-create Mongo patch. Shipped alongside Phase 0.

## Acceptance criteria

- Phase 0: the stdio server behaves exactly as before (same JSON-RPC responses for `initialize` /
  `tools/list` / `tools/call` / `ping` / notifications / unknown method / unknown tool / scope-denied), and
  the lifted handler has direct unit tests.
- Phase 1: an MCP client with a valid admin token can `initialize`, `tools/list`, and `tools/call` over
  HTTPS with **no SSH**; a missing/invalid/insufficient-scope token is rejected with the standard
  challenge; every call is audited identically to the stdio + HTTP paths; `/.well-known/oauth-protected-
  resource` resolves.
- `createClient` (and `POST /admin/v1/clients`) persists a supplied `claims` object; a client created with
  `claims:{role:product_runtime,email:…}` mints a token carrying those claims.

## Out of scope

- Phase 2 hardening details (DPoP/mTLS/DCR/step-up) — designed in ADR-0009, sequenced after the MVP.
- Any change to the tool catalogue or the authorization/scope model (unchanged from ADR-0007/0011).
- The maestro-side contracts (audit ingestion, remediation) — co-designed separately (ADR-0009 §10).
