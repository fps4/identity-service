---
title: "0009: A remotely-reachable, OAuth-authenticated MCP service — Streamable HTTP on a dedicated resource origin (auth-mcp.fps4.nl), sender-constrained tokens, with identity-service as its own authorization server"
summary: "Expose the management MCP server over the network as an OAuth 2.1 protected resource at https://auth-mcp.fps4.nl (a dedicated origin, distinct from the authorization server auth.fps4.nl) using the MCP Streamable HTTP transport. identity-service is the authorization server for its own MCP resource. Tokens are audience-bound and sender-constrained (DPoP/mTLS), admin scopes are role-derived and step-up-gated, clients self-register via gated dynamic registration, and every call flows through the existing admin-auth + audit path — so any MCP client connects with the standard remote-MCP flow instead of SSH+stdio."
status: accepted
last_updated: 2026-08-02
date: 2026-06-24
related:
  - ./0001-local-credential-idp.md
  - ./0005-decentralized-authorization.md
  - ./0007-management-api-mcp-and-standalone-identity-service.md
  - ../../product/RQ-0019-remote-authenticated-mcp.md
  - ../../guides/deployment.md
  - ../architecture.md
---

## Context

[ADR-0007](0007-management-api-mcp-and-standalone-identity-service.md) shipped the MCP server as the
agent face of the management plane: a thin protocol adapter over the same service layer and admin-auth +
audit path as the HTTP `/admin/v1` API. But it ships over **stdio**, and the only way to reach it remotely
is the SSH wrapper `docker/mcp-admin.sh`:

```
ssh ds1 /opt/identity-service/docker/mcp-admin.sh
```

That wrapper mints a fresh admin token inside the container and `docker exec`s `node dist/mcp/server.js`,
streaming JSON-RPC over the SSH pipe. It works, but the transport is the limitation, not the design:

- **It is not reachable off the box's network.** Today the client config points at `ssh ds1`
  (`192.168.2.19`, LAN). Off-network there is no route. The MCP server has no public endpoint at all —
  it is stdio-only, tunneled through SSH.
- **It requires shell access to a production host.** Every operator/agent that wants MCP needs an SSH
  account on ds1 and `docker exec` reach — a far larger grant than "call these eleven admin tools," and
  the wrong primitive to hand an agent.
- **AuthN is host-level, not protocol-level.** SSH gates *who can reach the box*; the admin token is then
  minted *for* the caller by the wrapper from the container's seeded secret. The MCP caller never proves
  an identity to the MCP server — the wrapper vouches for them. There is no per-MCP-client credential and
  no standard way for an MCP client (Claude, an IDE, an agent runtime) to authenticate.
- **It is not the flow MCP clients expect.** The MCP authorization spec defines a remote flow — discover
  the authorization server, run OAuth with PKCE in the browser, present a bearer token — that off-the-shelf
  clients implement. SSH+stdio is bespoke plumbing none of them speak.

The asymmetry to exploit: **this service is itself an OAuth authorization server.** It already runs the
`/oauth2/authorize`, `/oauth2/token`, `/oauth2/revoke`, and `/oauth2/callback` endpoints; supports
`authorization_code` + PKCE, `client_credentials`, and `refresh_token` grants; signs RS256 JWTs; and
publishes `/.well-known/jwks.json`. The MCP authorization spec needs exactly an authorization server in
front of the MCP resource — and we *are* one. We do not need to bolt on Auth0 or run a second IdP to put
the MCP server behind real auth; we make the identity-service the authorization server **for its own MCP
resource**.

This ADR keeps ADR-0007's invariant — one authorization model, one audit trail — and adds a **third
transport**: a network-reachable, OAuth-authenticated Streamable HTTP MCP endpoint, alongside the HTTP
admin API (for humans/automation) and stdio (kept for local/dev and break-glass). It deliberately favours
the **future-proof, best-practice** shape over the merely simplest one, because the resource being exposed
is high-privilege admin tooling on the public internet.

## Decision

**Expose the management MCP server over the network as an OAuth 2.1 protected resource at
`https://auth-mcp.fps4.nl` — a dedicated resource origin, separate from the authorization server
`auth.fps4.nl` — using the MCP Streamable HTTP transport, served in-process by the same Express app, with
identity-service acting as the authorization server for its own MCP resource. Tokens are audience-bound
(RFC 8707) and sender-constrained (DPoP, RFC 9449; mTLS, RFC 8705, for agents); admin scopes are
role-derived and require a step-up assurance claim; MCP clients self-register through gated dynamic client
registration; and every call is verified and scope-gated through the same admin-auth + audit path the
stdio server and HTTP API already use.** Concretely:

### 1. Add a Streamable HTTP MCP transport, in-process, on the existing service

The MCP server stops being a separate stdio process and becomes a **route in the running Express app** (the
same app that serves `/oauth2`, `/v1`, `/admin/v1`, and `/.well-known/jwks.json` on `PORT` 7305). It
implements the MCP **Streamable HTTP** transport (protocol revision `2025-03-26` or later, superseding the
stdio server's `2024-11-05` and the deprecated HTTP+SSE transport): a single endpoint handling `POST`
(client → server JSON-RPC, with optional SSE response streaming) and `GET` (server → client SSE stream),
with MCP's built-in protocol-version negotiation handling client skew.

The JSON-RPC core — `initialize`, `tools/list`, `tools/call`, `ping`, the eleven tools, and the
`principalHasScope` gate before each call — is **lifted unchanged** from `service/src/mcp/server.ts` into a
transport-agnostic handler. stdio and HTTP become two thin transports over one handler, exactly as the HTTP
API and stdio are two faces over one service layer today. No tool logic is duplicated, and the handler
stays extractable into its own deploy unit later without a rewrite.

### 2. A dedicated resource origin: `auth-mcp.fps4.nl`, distinct from the authorization server

The MCP resource gets its **own public origin**, `https://auth-mcp.fps4.nl`, which is the canonical
resource identifier. It is deliberately **not** a path on the authorization-server origin
(`auth.fps4.nl/mcp`) and **not** the same origin as token issuance:

- **Origin isolation is the security best practice for a hosted IdP.** The authorization server origin is
  the crown jewel (it mints tokens, holds login cookies/CSRF context). Resource servers — including admin
  tooling — belong on separate origins so an XSS, cookie, or CSP flaw on one does not share a blast radius
  with the other. Same-origin co-location would trade that isolation away for convenience.
- **The resource indicator only carries weight across origins.** Audience-binding (#5) is meaningful
  precisely because `https://auth-mcp.fps4.nl` is a distinct resource from `https://auth.fps4.nl`; the MCP
  spec's discovery chain (resource metadata → authorization-server metadata) is designed for this
  cross-origin case and is the well-trodden path, not an edge case.
- **Single-label subdomain, fleet-consistent, wildcard-friendly.** `auth-mcp.fps4.nl` sits under a
  `*.fps4.nl` wildcard cert (a two-level `mcp.auth.fps4.nl` would not), and establishes the fleet pattern
  `<service>-mcp.fps4.nl` for every other service that later exposes MCP.
- **Independent evolution.** A distinct origin lets the MCP edge be rate-limited, WAF'd, scaled, or moved
  to its own deploy unit without touching the token-issuance surface.

The reverse proxy / ingress adds one vhost `auth-mcp.fps4.nl → http://identity-service:7305/mcp`; the app
still serves it in-process for now.

### 3. identity-service is the authorization server for its own MCP resource

We implement the MCP authorization spec with the service playing **both roles**, advertised by metadata
served at the appropriate origins:

- **Protected Resource Metadata (RFC 9728)** at **`https://auth-mcp.fps4.nl/.well-known/oauth-protected-resource`**:
  the `resource` identifier (`https://auth-mcp.fps4.nl`), the `authorization_servers`
  (`https://auth.fps4.nl`), `scopes_supported` (the admin area scopes — `admin:tenants`, `admin:clients`,
  `admin:users`, `admin:keys`, `admin:stats`, and the `admin` superscope), and the supported
  sender-constraining methods (`dpop_signing_alg_values_supported`).
- **Authorization Server Metadata (RFC 8414)** at **`https://auth.fps4.nl/.well-known/oauth-authorization-server`**:
  describing the **existing** `/oauth2` plane — `authorization_endpoint`, `token_endpoint`,
  `revocation_endpoint`, `registration_endpoint` (#7), `jwks_uri` (the existing `/.well-known/jwks.json`),
  `grant_types_supported` (`authorization_code`, `client_credentials`, `refresh_token`),
  `code_challenge_methods_supported` (`S256`), and `dpop_signing_alg_values_supported`. These are
  descriptive — they document what already exists; no new OAuth machinery is invented here.
- **401 challenge.** An unauthenticated or under-scoped request to the MCP endpoint returns `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://auth-mcp.fps4.nl/.well-known/oauth-protected-resource"`,
  the signal MCP clients follow to begin discovery and authorization.

### 4. Authentication and identity assurance — separate authN from authZ, step up for admin

Two client shapes, both served by endpoints that already exist:

- **Interactive operators/agents — `authorization_code` + PKCE.** The MCP client opens `/oauth2/authorize`
  in a browser; the operator authenticates with the IdP that already backs the service (Google SSO, or
  local credentials per [ADR-0001](0001-local-credential-idp.md)); the client exchanges the code at
  `/oauth2/token` with `code_verifier`.
- **Headless agents — `client_credentials`.** A registered MCP client presents its credential for a machine
  token, preserving today's automation path without SSH.

Two principles make this future-proof rather than a hardcoded shortcut:

- **Admin scopes are role-derived, not stapled to a user record.** A human's `admin:*` entitlements come
  from **role/group membership resolved at token-issuance time**, so granting/revoking admin power is a
  membership change, not a token-schema edit. (This keeps authZ-of-the-product distinct from the
  decentralized product authZ of [ADR-0005](0005-decentralized-authorization.md): admin of identity-service
  itself is the service's own concern.)
- **Step-up assurance is required for admin scopes.** Issuing a token carrying `admin`/`admin:*` requires a
  satisfied MFA/assurance condition surfaced as an `acr`/`amr` claim; the MCP resource rejects admin-scoped
  tokens lacking the required assurance. Interactive grants also show an **explicit consent screen** naming
  the privileged scopes requested. Clients request **least-privilege per session** (only the scopes for the
  tools they will call), and key rotation (`admin:keys`) sits behind the highest assurance.

### 5. Audience-bound *and* sender-constrained tokens

Bearer tokens for admin power are a single-factor-of-possession liability: a leaked token is full
compromise. So MCP tokens are constrained two ways:

- **Audience-bound (RFC 8707).** Clients request tokens with `resource=https://auth-mcp.fps4.nl`; the
  token's audience is bound to the MCP resource and verified on every request. A token minted for another
  resource is rejected at the MCP endpoint, and an MCP token cannot be replayed against an unrelated
  resource server — the token-confusion mitigation the MCP authorization spec calls for.

  **Which resources are acceptable is a per-application registry**, not a single global value: an
  application (ADR-0020) declares the resources it owns in its `resources` list, and a credential may bind
  a token only to one of those — or to this service's own `MCP_RESOURCE_URL`. The scoping *is* the
  token-confusion mitigation applied one level up: without it, either every product's resource would be
  acceptable to every credential, or (as was the case until this registry existed) only identity-service's
  own MCP resource would be acceptable at all, and no other product could sit behind this authorization
  server. Registration is GitOps by default (`resources:` in the seed file), runtime-editable through
  `PUT /admin/v1/applications/{id}/resources` and the `set_application_resources` MCP tool.
- **Sender-constrained (RFC 9449 DPoP / RFC 8705 mTLS).** Tokens are bound to a key the client holds:
  **DPoP** for interactive/public clients (a per-request proof JWT), **mTLS-bound** as the option for
  headless agents. **Sender-constraining is required for high-privilege scopes** (notably `admin:keys`);
  for clients that cannot yet do DPoP, a **bearer fallback is permitted only with a short TTL and only for
  lower-privilege scopes**, and that allowance is a tracked deprecation, not a permanent mode. This is the
  OAuth 2.0 Security BCP (RFC 9700) posture for sensitive resources.

### 6. Short admin-token lifetimes with a real revocation path

JWTs verify locally (no introspection round-trip) but are valid until expiry, which is wrong for admin
power. So:

- **Short admin/MCP access-token TTL** (target ~5 min, well under the default 15) with **refresh-token
  rotation**, shrinking the replay window.
- **Revocation that actually bites:** the existing `/oauth2/revoke` plus a **`jti` denylist** checked at the
  MCP resource for emergency kill of a specific token before it expires; optional RFC 7662 introspection is
  available if a future verifier needs real-time status. Revoking a compromised admin session must not wait
  out a token lifetime.

### 7. Gated dynamic client registration — done properly, not deferred

MCP clients increasingly *expect* to self-register; making every new client a manual `/admin/v1/clients`
action is an operational bottleneck and not future-proof. But the MCP resource fronts **admin-power
tooling**, so open registration is unacceptable. The resolution is **gated** dynamic registration:

- **RFC 7591 with an initial access token.** Registration requires a one-time, admin-issued initial access
  token (or a signed software statement); there is no anonymous open registration.
- **Zero privilege by default.** A freshly registered client receives **no** `admin:*` scope; elevation to
  any admin scope is a separate, audited admin action. Registering a client is thus convenient but is never
  itself a privilege-escalation vector.
- **Lifecycle management (RFC 7592).** Registered clients can be read/updated/deleted via the registration
  management protocol, with fixed redirect-URI and scope allow-lists enforced server-side.

Phase 1 may still pre-register the known clients (Claude, the operator's IDE, the seeded
`identity-admin-mcp`) to bootstrap; gated DCR is the **target steady state**, not a "maybe later."

Initial access tokens are minted by identity-service's **own admin plane** (§10, amended) — an
`admin:clients` action in `/admin/v1` or the operator console, audited like any other. Custody of the
resulting agent credentials belongs to whatever runtime uses them; no external broker sits between this
service and the ability to register or revoke an agent.

Note that gated DCR is not what connects a general-purpose MCP client: clients following the MCP
specification register **anonymously**, which this deliberately refuses, and a freshly registered client
holds no `admin:*` scope regardless. Such clients are pre-registered and granted scope explicitly —
which is the intended friction for admin-power tooling, not a gap.

### 8. Authorization and audit are unchanged in model — strengthened in observability

The MCP endpoint reuses the ADR-0007 machinery wholesale: `verifyAdminToken` (issuer = `AUTH_JWT_ISSUER`,
verified against the local JWKS, now also enforcing audience + sender-constraint + assurance) yields the
`AdminPrincipal`; `principalHasScope(principal, tool.areaScope)` gates each tool; every call (allowed,
denied, failed) is written append-only to the `AuditLog` collection. One authorization model, one audit
trail, **three transports.** Strengthened:

- **Structured, attributable audit** gains a transport discriminator (`method: 'MCP'`, `transport: 'http'`),
  the `client_id`, the `resource`, the scopes actually exercised, and a request/trace id — **readable over
  `/admin/v1/audit`** and correlatable by an ops plane that chooses to subscribe (§10). fps4/* services do
  not onboard to external SaaS such as Datadog.
- **Tamper-evidence (optional, follow-up):** the per-call records are hash-chainable so retroactive edits
  are detectable; this service emits the links, and any fleet-wide chain is built by a reader from them.
- For **interactive users**, the audited principal is the `sub` (the human), preserving per-actor
  attribution that ADR-0003 required and a static secret could not give.

This requires the one substantive change to the principal model, called out as work: today
`verifyAdminToken` requires a machine token (a `cid` claim) and rejects user-subject tokens. The
interactive flow in #4 produces **user** tokens, so admin authorization must be extended to accept a user
principal **that carries (role-derived) admin scopes and the required assurance**. This is the crux change
and is sequenced first.

### 9. Network exposure and defense in depth

Putting admin tooling on the public internet is the ADR-0003/0007 attack surface, now larger and public.
It ships with layered controls, not a single gate:

- **Transport hardening:** validate the `Origin` header (DNS-rebinding protection), an explicit **CORS
  allow-list** for browser-based MCP clients, and **stateless, request-scoped** handling — each JSON-RPC
  request re-derives its principal from the (constrained) token rather than holding long-lived server
  sessions, so there is no session to fixate; any `Mcp-Session-Id` is bound to the authenticated principal.
- **Abuse controls:** per-principal **rate limiting** at the MCP origin, a WAF in front of
  `auth-mcp.fps4.nl`, and anomaly alerting off the shipped audit stream.
- **Blast-radius limits:** least-capability scopes per agent, the highest-privilege tools behind
  sender-constraint + step-up, and `ADMIN_API_ENABLED=false` as a **kill switch** that disables the whole
  management plane (MCP included), as today.
- **stdio retained as break-glass:** the SSH `docker/mcp-admin.sh` path stays for local/dev and for
  recovery when the HTTP plane is intentionally closed or down; it is no longer the *primary* remote path.

### 10. Relationship to the ops plane — self-hosted custody, no consumer dependency

> **Amended 2026-08-01.** This section originally designated **maestro** — fps4's internal agentic-ops
> product — as the agent-credential custodian, the audit aggregation plane, and the closed-loop
> remediation caller. maestro is being decommissioned. A replacement is expected later, and this ADR
> deliberately does **not** re-create the dependency on it. None of what follows was ever built, so the
> amendment costs no rework.

identity-service is **upstream** of every consumer it authenticates. Delegating custody of the
credentials it issues to one of those consumers inverts the layering: the IdP would be unable to onboard
an agent, or rotate a compromised credential, without a downstream service being available. That is the
wrong dependency direction for the component the rest of the fleet's trust roots in, and the objection
holds regardless of which product occupies the ops role. The boundary is therefore drawn at capability,
not at product:

- **This service is its own credential custodian.** The gated DCR of #7 issues initial access tokens from
  identity-service's **own admin plane** — `/admin/v1` plus the operator console, which already
  authenticate `platform_admin` operators (ADR-0010) and already write the audit trail. Registering,
  scoping, rotating and revoking an agent credential is an admin-plane action like any other, gated by
  `admin:clients` and attributed to the principal that performed it. No external broker is required for
  the IdP to be fully operable.
- **The local `AuditLog` is the system of record, and is sufficient on its own.** identity-service keeps
  its append-only audit (per [ADR-0008](0008-drop-sops-db-is-system-of-record.md)) and exposes it over
  `/admin/v1/audit`. A future ops plane may *subscribe* to add fleet-wide correlation, anomaly detection
  and notification routing — but as an optional **reader**, never as a dependency: losing it degrades
  analysis, not authentication, and not the ability to investigate.
- **Runtime signals stay in-process.** Golden signals are recorded locally and reported through
  `/admin/v1/stats`. The outbound heartbeat/telemetry push to maestro has been removed.
- **The MCP tools remain the action surface** for whatever operator runtime exists — human, scripted, or
  agentic. This is *why* the security controls above are load-bearing rather than ceremonial: any
  automated caller must act under least-privilege scopes, sender-constrained tokens, step-up for the
  highest-risk tools (`rotate_signing_key` stays behind the strongest constraint even for a runbook), and
  per-actor audit. Those controls are properties of the endpoint, so they hold whoever calls it.

Ops *intelligence* — dashboards, correlation, alerting — still does not belong in the IdP (consistent
with [ADR-0005](0005-decentralized-authorization.md)). What changes is that its absence is now a missing
**consumer** of already-exposed contracts, not a missing dependency of this service.

### Rollout phases

1. **Refactor:** split the MCP JSON-RPC/tool core from the stdio transport into a shared handler.
2. **Principal model:** extend admin-auth to accept role-derived, assurance-gated **user** admin tokens
   (the §4/§8 crux), with per-actor audit on `sub`.
3. **Resource endpoint:** mount Streamable HTTP, stand up `auth-mcp.fps4.nl` (vhost + cert + WAF), serve
   RFC 9728/8414 metadata and the 401 challenge; audience-bind tokens.
4. **Sender-constraining:** DPoP (interactive) and mTLS (agents); require it for `admin:keys`, short-TTL
   bearer fallback elsewhere as a tracked deprecation.
5. **Self-service:** gated RFC 7591/7592 dynamic registration with initial access tokens and zero-default
   privilege; pre-registered clients remain the bootstrap.

### Why not the alternatives

- **Keep SSH + stdio (uphold ADR-0007's transport as-is).** Functional but fails the requirement: no
  off-network reach, requires production shell access per caller, and is not the flow MCP clients speak.
  Kept as break-glass, not as the door.
- **Same-origin path `auth.fps4.nl/mcp` instead of a dedicated origin.** Simpler (one vhost, one cert, no
  cross-origin discovery), and was the first draft's choice — but it co-locates admin tooling with the
  token-issuance crown-jewel origin, weakens the resource-indicator/audience model, and bakes in a
  coupling that is expensive to undo. We pay the small extra setup for origin isolation now.
- **Bearer-only tokens (skip DPoP/mTLS).** Simplest and widely interoperable, but a single leaked admin
  bearer is total compromise. We require sender-constraining for high-privilege scopes and treat bearer as
  a short-TTL, lower-scope, deprecating fallback.
- **Static `admin:*` scopes stapled to user records (skip role-derivation/step-up).** Easy to ship, but
  makes admin grants a schema edit and gives privileged tokens with no assurance signal. Role-derived,
  step-up-gated scopes are the maintainable, auditable shape.
- **Defer dynamic registration; pre-register forever.** Manual registration is fine to bootstrap but
  becomes a bottleneck as MCP clients proliferate and expect DCR. Gated DCR (IAT + zero default privilege)
  gives self-service without an escalation path.
- **Stand up a separate authorization server (Auth0/Keycloak) in front of MCP.** Rejected — we already run
  a conformant OAuth authorization server with JWKS, PKCE, and revocation. A second IdP adds an
  integration, a second issuer, and a second audit story for zero capability we lack.
- **Run MCP as its own container/service now.** Rejected for now — the handler needs the same Mongo reach,
  signing keys, issuer, and service layer the app already has (which is why the stdio server runs *inside*
  the container today). In-process keeps one deploy unit and one config; the dedicated origin (#2) and the
  transport-agnostic handler (#1) keep extraction cheap when scale demands it.
- **Open dynamic registration / static API key at the MCP endpoint.** Rejected for the reason ADR-0003
  rejected static secrets for the management API: no per-actor attribution, no scoped authority, trivial
  privilege escalation. The gated OAuth flow gives all three.

## Consequences

- **The management plane gets its largest attack surface yet — admin tooling on the public internet.** It
  is defended in depth: OAuth 2.1 with PKCE, audience-bound **and** sender-constrained tokens, role-derived
  step-up-gated admin scopes, short TTLs with revocation that bites, per-principal rate limiting, a WAF,
  origin/CORS validation, anomaly alerting off shipped audit, and an `ADMIN_API_ENABLED` kill switch. This
  is a standing security responsibility; `auth-mcp.fps4.nl` belongs in the security-review and pen-test
  rotation.
- **The admin-auth principal model must accept role-derived, assurance-gated user tokens**, not just
  machine (`cid`) tokens — the prerequisite for the interactive flow. This touches
  `service/src/core/admin-auth.ts` (audience, DPoP/mTLS confirmation, `acr`/`amr` checks, user principals)
  and the audit attribution (audit on `sub` for users). It is the first build step and a contract change to
  the admin-auth layer ADR-0007 introduced.
- **New OAuth capabilities to build, not just document:** DPoP/mTLS verification (RFC 9449/8705), audience
  binding (RFC 8707), a `jti` denylist for revocation, role→scope derivation with step-up, gated dynamic
  registration (RFC 7591/7592), and the two metadata documents (RFC 9728/8414). The metadata must track any
  change to the `/oauth2` plane.
- **New public infrastructure:** the `auth-mcp.fps4.nl` vhost, its TLS cert (under `*.fps4.nl`), and its
  WAF/rate-limit config — a new edge to operate, separate from `auth.fps4.nl`.
- **The stdio server becomes a thin transport over a shared handler** — a small refactor of
  `service/src/mcp/server.ts` to split transport from JSON-RPC/tool logic, after which stdio and HTTP share
  one code path (and one place to add tools).
- **MCP protocol version moves forward** (`2024-11-05` → `2025-03-26`+) to get Streamable HTTP and the
  authorization spec; the tool catalogue and scopes are unchanged from ADR-0007.
- **Audit becomes an observability stream, not just a collection** — readable over `/admin/v1/audit`, with
  anomaly alerting and (optionally) hash-chaining for tamper-evidence left to a subscriber (§10).
- **DPoP introduces an interop tradeoff:** clients that cannot do DPoP yet fall back to short-TTL bearer on
  lower-privilege scopes only, tracked as a deprecation; the highest-privilege tools are unavailable to
  non-constrained clients by design.
- **No consumer is on the critical path** (§10, amended 2026-08-01): credential custody, audit, and
  runtime signals are all self-hosted, so this service stays fully operable with no ops plane present. The
  cost is that fleet-wide correlation, anomaly detection and alerting do not exist until some consumer
  subscribes to the contracts exposed here — an accepted gap, and a smaller one than an IdP that cannot
  onboard or revoke an agent while a downstream service is down. Automated remediation still means a
  compromised operator runtime can drive admin actions, bounded as ever by least-privilege scopes, step-up
  on the riskiest tools, and audit.
- **Follow-ups (named, not built here):** the concrete role/group model and where membership lives; the
  step-up assurance mechanism for local-credential users (Google SSO can enforce MFA upstream); audit
  hash-chaining; CORS specifics for browser MCP clients; refresh-token rotation tuning for long-lived MCP
  sessions; and load/abuse testing of the public MCP surface.

## Status & phased implementation (accepted 2026-07-05)

Accepted and tracked by [RQ-0019](../../product/RQ-0019-remote-authenticated-mcp.md). The trigger was
operational: the stdio-over-SSH transport (`ssh ds1 docker/mcp-admin.sh`) dropped mid-session during the
ds1 fleet-telemetry work (SSH idle timeout), stranding the management plane — exactly the fragility this
ADR removes. Delivered in phases so "remote, no-SSH" lands early and the hardening follows:

- **Phase 0 — transport-agnostic core (no behaviour change).** Split `service/src/mcp/server.ts` into a
  transport-agnostic JSON-RPC/tool handler + a thin stdio transport over it, so a second transport can be
  added without duplicating tool logic (Decision §1, "lifted unchanged"). Prerequisite for everything
  below; ships on its own with handler-level tests.
- **Phase 1 — MVP remote transport.** Add the MCP **Streamable HTTP** transport in-process on the existing
  Express app, as an OAuth 2.1 protected resource verified through the same `verifyAdminToken` + scope gate
  and audit path. Publish `/.well-known/oauth-protected-resource`. Delivers "connect remotely with the
  standard MCP OAuth flow, no SSH, no prod shell account."
- **Phase 2 — hardening.** Dedicated `auth-mcp.fps4.nl` resource origin, audience-binding (RFC 8707),
  sender-constraint (DPoP / mTLS), role-derived scopes with a step-up assurance claim, gated dynamic client
  registration, and self-hosted credential custody (§10). stdio-over-SSH is kept as documented break-glass.

Related enabler: [ADR-0017](0017-product-runtime-self-registration-invites.md)'s self-registration and the
management plane's `create_client` both need the client to carry `claims` (e.g.
`role: product_runtime`); the admin `createClient` is extended to accept/persist `claims` alongside this
work so product-runtime clients can be created wholly through the management plane.

### Delivery status (updated 2026-08-02)

| Increment | Status | Ref |
| --- | --- | --- |
| `createClient` accepts/persists `claims` (enabler) | **Done** | #66 |
| Phase 0 — transport-agnostic core + handler tests | **Done** | #66 |
| Phase 1 — Streamable HTTP transport, OAuth-protected, discovery metadata | **Done** (live-verified) | #67 |
| Phase 2 — dedicated `auth-mcp.fps4.nl` origin + config threading | **Done** (live-verified) | #68, #69 |
| Phase 2 — audience-binding (RFC 8707) for **machine** tokens | **Done** (live-proven: bound→200, unbound→401) | #68 |
| Phase 2 — Origin / DNS-rebinding allow-list on `/mcp` | **Done** | #70 |
| **`authorization_endpoint` published in AS metadata** (§3) | **Done** | #86 |
| **First-party interactive login** — browser leg without a Google app | **Done** | #86 |
| **Audience-binding for *user* tokens** (`resource` on authorize + exchange) | **Done** | #86 |
| **Per-application protected-resource registry** (§5 — another product's MCP endpoint) | **Done** | this change |
| Phase 2 — **DPoP / mTLS sender-constraint** | **Backlog** | — |
| Phase 2 — **step-up assurance** (acr/amr on the riskiest tools) | **Backlog** | — |
| Phase 2 — **gated dynamic client registration** (RFC 7591) | **Backlog** | — |
| Phase 2 — **browser-client `Origin` allow-listing** (populate `MCP_ALLOWED_ORIGINS`) | **Backlog** | — |
| **Ops-plane subscriber** (§10: reads `/admin/v1/audit` + `/admin/v1/stats`) | **Backlog** (awaits maestro's replacement) | — |

The remote, no-SSH transport is in production and hardened for the machine/agent case (audience-bound
bearer + `Origin` allow-list + per-tool scope + audit, on an isolated origin). The backlog items above are
refinements that add sender-constraint or self-service onboarding; they are deferred, not blocking, and
`stdio`-over-SSH remains the break-glass path throughout.

**The interactive path closed in #86.** Three things stood between a standard MCP client and this
resource, none of them visible from outside — the endpoint answers discovery correctly and a machine
token gets a `200`, so the failure looked like a client problem:

1. **AS metadata advertised `authorization_code` but published no `authorization_endpoint`**, so a
   spec-following client had nowhere to send the user. §3 above always specified one; the implementation
   had simply drifted from it.
2. **`startAuthorization` required a Google app unconditionally.** ds1 sets no `GOOGLE_*`, so the browser
   leg returned `invalid_request` ("Google login is not configured"). The service has had its own
   credential IdP since RQ-0002, but only the non-interactive `password` grant could reach it. The
   authorize endpoint now serves a first-party login form when no upstream IdP is configured; setting the
   Google env switches the same endpoint back to federation, so neither choice is a dead end. This also
   matches §10's direction — an IdP that cannot log its own operator in without a consumer relationship
   has the layering backwards.
3. **User tokens could not be audience-bound.** `resource` was honoured only on `client_credentials`;
   the authorization-code path ignored it and inherited `aud` from the *application* (ADR-0020), which is
   never the MCP resource — so `MCP_REQUIRE_AUDIENCE` rejected every operator token. The indicator is now
   read at authorize (validated before any login prompt, and pinned to the record) and re-checked at the
   exchange, where a mismatch is `invalid_target` rather than a quiet re-target.

Gated DCR (§7) remains backlog and remains *not* the thing that connects a general-purpose MCP client:
those register anonymously, which §7 refuses, and a self-registered client holds no `admin:*` scope. The
intended path is pre-registration plus an explicit operator assignment carrying `platform_admin`.

**#86 closed the interactive path for *this service's own* resource only.** The allow-list it introduced
was `[CONFIG.mcp.resourceUrl]` — a single global value, this service's own MCP URL — so an MCP client for
any *other* product (Skills Coach's `https://coach-mcp.fps4.nl/mcp` was the first) was refused
`invalid_target` at `/oauth2/authorize` no matter how it was registered. Because MCP spec 2025-06-18
requires the `resource` parameter, that 400 lands before the browser opens, so the failure reads as "the
client did nothing" and sends you looking at the client, the credential, or the seed file — none of which
were at fault. The allow-list is now `[own MCP resource, ...application.resources]`, and a product
declares its own endpoint in its seed file. Two things worth keeping in mind:

- The registry is **replaced wholesale** on every seed run, exactly like `roles` — a seed file naming an
  application must restate its full `resources` list or it silently empties it.
- It gates **issuance**, not verification. Removing a resource stops new tokens; already-issued ones keep
  their `aud` until they expire, and a refresh re-mints against the resource the chain was bound to — so
  revoke the session to cut an in-flight chain off.
