# Codebase overview

**identity-service** is an authentication building block shared across products — one deployment is one
realm with a single shared user pool ([ADR-0018](docs/design/decisions/0018-collapse-tenant-into-deployment.md)). It is
onboarded as a managed product (`kind: component`, `product_type: technical`) under the shared
documentation standard. It is a standalone TypeScript service plus a lightweight SDK. It owns
**authentication** (who you are) only — consuming products keep their own **authorization** (what
you may do).

It is a standalone TypeScript service, a headless SDK, and an optional React UI package
(`@fps4/identity-service-react`) with a drop-in `<Login/>`.

It issues two kinds of JWT, both RS256-signed and verifiable via a published JWKS:

- **Machine tokens** — `client_credentials` grant; claims `cid` / `sid` / `scope`.
- **User identity tokens** — Google SSO via OIDC Authorization Code + PKCE (RQ-0001) **or** a local
  email/password IdP (RQ-0002); claims `email` + a stable `sub` + `iss` + a consumer-bound `aud` +
  `exp`/`iat`, plus an optional **`roles`** array — the user's **app-scoped** roles for that `aud`, from
  their assignment (ADR-0019), which consumers map to permissions (identity-service asserts roles but does
  not enforce them — ADR-0005). The `aud` is the **application's** audience (or the credential's override —
  ADR-0020). Issuance is **entitlement-gated**: the gate resolves the credential → its application and a
  user needs an active assignment to that **application** or the grant is refused (`access_denied`, ADR-0019).
  Both IdPs issue the same token; the local IdP is toggled deployment-wide (`AUTH_LOCAL_IDP_ENABLED`).

Both carry **`prn`** — the **maestro principal id** (`prn-h-…` a human, `prn-a-…` an agent, `prn-w-…` a
workload) this service mints and keeps in its `principals` registry — and `principal_kind` (ADR-0022).
identity-service is **maestro's principal registry**: it emits `PrincipalRegistered`, `PrincipalSuspended`,
`PrincipalReinstated` and `SeatOccupancyChanged` as maestro **spine** envelopes through a transactional
**outbox** that a relay drains into maestro's archive (`RECORD_SINK`). An application's role is the
**seat**; an assignment is its occupancy. An act the spine would refuse is not performed.

## Directory map

| Path | Purpose |
|------|---------|
| `service/` | The Express API + Docker assets. Stateless container; MongoDB is the only persistent dependency. |
| `service/src/oauth/` | OAuth server core: `server.ts` (grant logic — extension point for new grants), `google.ts` (upstream Google OIDC adapter), `pkce.ts`, `errors.ts`, `types.ts`. |
| `service/src/routes/` | HTTP surface: `oauth-routes.ts` (`/oauth2/*`), `session-routes.ts` (legacy `/v1/*`), `admin-routes.ts` (`/admin/v1/*` management plane — ADR-0007). |
| `service/src/mcp/` | `server.ts` — MCP management server (stdio JSON-RPC, `npm run mcp`) exposing the admin operations as agent tools, over the same service layer + admin-auth + audit (ADR-0007). |
| `service/src/core/` | JWT signing helpers, the session authorizer, and `admin-auth.ts` (verifies admin client-credentials tokens + scopes — ADR-0007). |
| `service/src/models/` | Mongoose models: application (owns audience + role catalogue — ADR-0020), oauth-client (a credential under an `applicationId`, no role catalogue; `principalId` for a machine credential), oauth-token, oauth-authorization, user (no `roles` field; `principalId`), assignment (user↔app entitlement, keyed on `applicationId` — ADR-0019/0020), session, key-store, audit-log (ADR-0007), and maestro's record (ADR-0022): principal (the registry row — retired, never deleted), outbox (spine envelopes + relay bookkeeping), counter (`seq` / `subject_seq`). |
| `service/src/services/` | `users.ts` — local-credential registration (RQ-0002; registers the principal in the `self` seat); `admin.ts` — management operations for applications (+role catalogues, members, credentials — ADR-0020), users, assignments (ADR-0019), keys + stats (ADR-0007); every mutating operation takes the act context and emits to the record (ADR-0022). |
| `service/src/record/` | maestro's record (ADR-0022): `ids.ts` (mint `prn-…`), `types.ts` (the four event types' body schemas, registered with the spine), `registry.ts` (ensure/backfill a principal, resolve kinds), `outbox.ts` (the recorder: the attribution rules + the envelope built and validated in the transaction), `transaction.ts` (transactions where the database allows, probed once), `context.ts` (who is acting — from the admin token, or the principal itself), `source.ts` (`OutboxSource` over the `outbox` collection), `relay.ts` (`RECORD_SINK` → archive + delivery; the in-process loop), Depends on `@fps4/maestro-spine`. `service/src/relay/lambda.ts` is the scheduled relay Lambda's entry point (`handler`), beside the service and backup bundles. |
| `service/scripts/` | Operator CLIs: `manage-users.ts` (create/reset/lock/unlock/disable users — predates the record; not a recorded path) and `seed.ts` (idempotent `npm run seed` loader — RQ-0004; an operator's recorded act, `--as=<email>`); `bundle.mjs` (`npm run bundle`: the Lambda bundles the Terraform module deploys, reproducibly) and `bundle-smoke.mjs` (boots the service bundle). |
| `service/lambda/` | The scheduled backup Lambda (`backup.ts`: every collection to S3 as canonical Extended JSON lines; optional AES-256-GCM in `backup-crypto.ts`; `backup-decrypt.ts` for a restore). Outside `src/` on purpose: it is the deployment's code, not the service's, and the service's `tsc` never sees it (`npm run typecheck:lambda` does). |
| `terraform/` | The deployment (maestro ADR-0016): the service on Lambda behind the Web Adapter and an HTTP API, the backup Lambda on a schedule, the backup bucket, alarms. Composed by a tenant's private root; `tests/` runs against a mocked provider; `examples/demo` is the demo tenant with placeholders. |
| `config/` | `seed.example.yaml` (committed template) → `config/seed.yaml` (gitignored): applications (+ role catalogues + their credentials), users, and per-user assignments for seed provisioning (ADR-0019/0020). |
| `service/src/utils/` | Key store (RSA generate/rotate + JWKS), db, hashing, CORS, logging. |
| `service/tests/` | Vitest suites (dependency-injected, no network/DB). |
| `sdk/` | Headless TypeScript client: `requestClientCredentialsToken` + the Google login helpers (`beginGoogleLogin` / `completeGoogleLogin` / `refreshUserToken` / `revokeUserToken`) + `registerWithPassword` / `loginWithPassword`. No UI; safe server-side. |
| `react/` | **Optional** React UI package `@fps4/identity-service-react` — a drop-in `<Login/>` (password) for consumer apps (RQ-0003 / ADR-0002). Separate package so server-side consumers never pull in React. |
| `console/` | **Operator** admin console (Next.js, `@fps4/identity-service-console` — ADR-0007). Thin server-side client over `/admin/v1`: dashboards + application/credential/user management (top level is Applications — ADR-0020). Distinct from the consumer `<Login/>` widget. |
| `docker/` | Compose base + dev/prod overlays (the development loop); `backup.sh` (nightly backups of the compose stack) + `migrate-rename-ds1.sh`. Deployment is `terraform/`, applied by a tenant's pipeline — nothing here deploys (see `docs/guides/deployment.md`). |
| `docs/` | Two-plane docs: `design/` (architecture + ADRs), `reference/` (API), `guides/` (deployment config, deployment), `product/` (RQ specs). Index: `docs/README.md`. |

## Entry points

- **Machine token (in):** `POST /oauth2/token` (`grant_type=client_credentials`) → `oauthServer.issueClientCredentialsToken`.
- **User login — Google (in):** `GET /oauth2/authorize` → Google → `GET /oauth2/callback` → consumer redirect with a code → `POST /oauth2/token` (`grant_type=authorization_code` + PKCE) → user JWT + refresh token.
- **User login — local (in):** `POST /v1/register` then `POST /oauth2/token` (`grant_type=password`) → the same user JWT + refresh token (RQ-0002).
- **Token refresh / revoke (in):** `POST /oauth2/token` (`grant_type=refresh_token`); `POST /oauth2/revoke`.
- **Verification (out):** consumers fetch `GET /.well-known/jwks.json` and verify tokens by `kid` (e.g. maestro's JWT verifier at its authenticated edge).
- **The record (out):** every registry act → `outbox` (same transaction) → the relay (`service/src/record/relay.ts` in-process, or `service/src/relay/lambda.ts` on a schedule) → maestro's archive + `events.fifo`. `spine-verify <archive> --workspace <ws>` verifies it with everything off.
- **Boot:** `service/src/server.ts` → `bootstrap()` (starts the relay loop unless `RECORD_SINK=off`).

## Naming notes

- **deployment / realm** — one instance = one realm = one shared user pool; realm-wide config is deployment env, users are deployment-scoped, and there is no `Tenant` entity (ADR-0018).
- **application** — the first-class per-consumer object (a product); owns its `name`, default `audience`, and role catalogue, and is what users are assigned to (ADR-0020).
- **client / credential** — an OAuth client *under* an application (`applicationId`); the auth material (grant types, redirect URIs, scopes, secret) that authenticates *as* the application. Carries no role catalogue; may set an `audience` override (ADR-0020).
- **audience (`aud`)** — the consumer/workspace a user token is bound to (the application's audience, or a credential override); a token minted for one is not valid for another.
- **principal / `prn`** — maestro's word for anyone or anything that acts and is recorded; its id (`prn-h-…` / `prn-a-…` / `prn-w-…`) is minted here and is the only identifier of a person or machine that reaches maestro's record (ADR-0022). A user is a human; a `client_credentials` credential is an agent (`claims.principal_kind: agent`) or a workload.
- **seat / occupancy** — maestro's role-in-a-process and who holds it. Here the application's **role** is the seat and the **assignment** its occupancy; `SeatOccupancyChanged` is emitted per role that changes hands (ADR-0022). Not the envelope's own `seat` field, which is the seat an act was performed *from* (`operator` or `self`).

## Out of scope

- **Authorization enforcement** — owned by the consuming product. identity-service stores app role
  catalogues + assignments and stamps app-scoped roles (ADR-0019), but the role→capability mapping and
  enforcement live in the product, never mirrored here.
- **Non-Google IdPs / magic-link** — deferred (RQ-0001 out of scope).
- **The consumer's login UI** — the SDK helper is shipped here; the UI lands in the consumer.
