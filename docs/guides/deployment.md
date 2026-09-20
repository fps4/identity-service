---
title: Deployment
summary: How identity-service is deployed — the Terraform module in terraform/ (one DynamoDB table, the service on Lambda behind an HTTP API, a relay and a backup Lambda), applied by the tenant's pipeline (maestro ADR-0016/0017; nothing here deploys); what a deployment needs, the compose stack for a laptop, seeding, backups & recovery, and provisioning the management-plane admin client + MCP server.
status: current
last_updated: 2026-09-20
owners: [architect]
related:
  - docs/design/architecture.md
  - docs/design/decisions/0023-the-store-is-dynamodb.md
  - docs/guides/tenant-config.md
  - docs/design/decisions/0007-management-api-mcp-and-standalone-identity-service.md
  - docs/design/decisions/0019-application-assignments-and-app-roles.md
  - docs/design/decisions/0020-application-aggregate.md
---

# Deployment

How identity-service is deployed. The service is **stateless**, driven entirely by environment variables,
with **one DynamoDB table** as its only persistent dependency
([ADR-0023](../design/decisions/0023-the-store-is-dynamodb.md), maestro ADR-0018). A deployment is the
Terraform module below; the `docker/` compose stack runs the same container on a laptop against DynamoDB
Local and is the development loop, not a deployment target (maestro ADR-0002).

## The Terraform module, applied by the tenant's pipeline

[`terraform/`](../../terraform/) makes the realm's DynamoDB table and deploys the service as a Lambda
function (Node 22, arm64) behind the [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
layer and an HTTP API Gateway with one `$default` route, the relay and the backup as scheduled Lambdas,
and the backup bucket; each function's role is granted the table, and no database credential exists. The README's
[Deployments](../../README.md#deployments) section is the reference: the inputs table, a root that
composes the module, the issuer, secrets, seeding, backups and the console's status. The short form:

- **The code** is `npm run bundle` in `service/` (Node 22): `bundle/service.zip` (the server plus
  `run.sh` for the adapter's zip mode) and `bundle/backup.zip`; `npm run sbom` adds a CycloneDX SBOM per
  bundle. The tenant's pipeline builds them at the tag it deploys.
- **`environment`** is every non-secret variable in [`service/.env.example`](../../service/.env.example)
  (the module sets `TABLE_NAME` itself); **`secrets`** maps `OAUTH_KEY_PASSPHRASE`, `AUTH_JWT_SECRET`,
  `IDENTITY_ADMIN_CLIENT_SECRET` and, when Google federates, `GOOGLE_CLIENT_SECRET` to Secrets Manager
  ARNs. Their values land on the function and in the state — the state bucket protects them (ADR-0017);
  reading them at boot through the Secrets Lambda extension is the follow-up.
- **The table** is the module's (`terraform/table.tf`): on-demand, point-in-time recovery, TTL, encrypted,
  `prevent_destroy`. Its shape is declared once more in [`service/src/db/table.ts`](../../service/src/db/table.ts),
  which the service checks its table against at boot; the two must match.
- **The issuer** (`AUTH_JWT_ISSUER`, the `iss` of every token) is set by the module and output as
  `issuer`: `https://<domain>` with a `domain` + `certificate_arn`, else the API's default endpoint.
  Use a domain: the default endpoint changes if the API is ever recreated, and every consumer's
  verifier with it. `GOOGLE_REDIRECT_URI` is `<issuer>/oauth2/callback` and `MCP_RESOURCE_URL` defaults
  to `<issuer>/mcp`.
- **The signing keys** are generated on first use and stored in the table (`key_store` items), encrypted
  under `OAUTH_KEY_PASSPHRASE` (`src/utils/key-store.ts`) — nothing on disk. Set the passphrase before
  the first request and never change it without re-encrypting.
- **The web adapter layer** is an input (`web_adapter_layer_arn`): its ARN carries AWS's account id,
  which a public repository may not hold.
- **The console** is not in the module — the README says why and what follows.

The tenant's private repository (`fps4/maestro-config-<tenant>` —
[`maestro/docs/tenancy-and-config.md`](https://github.com/fps4/maestro/blob/main/docs/tenancy-and-config.md)) composes the
module with its own values and **applies it from its own pipeline** (ADR-0016, ADR-0017).
**Nothing in this repository deploys anywhere.** Its CI runs on GitHub-hosted runners and ends at the
gate: [`terraform.yml`](../../.github/workflows/terraform.yml) formats, validates and tests the module
against a mocked provider and builds, boots and SBOMs the bundles; a self-hosted runner on a public
repository would run a fork's code (ADR-0017). The earlier ds1 deploy (`deploy-ds1`), seed
(`seed-ds1`), snapshot (`dump-ds1`) and one-shot migration (`migrate-*-ds1`) workflows, and the
committed `config/ds1/.env.base` they assembled a deploy env from, are gone: the deploy is the module,
the realm's values are the tenant's, and a seed is run from `service/` against the deployment's table by
whoever holds a role that may write it (below).

## What a deployment needs

- The **table** — `TABLE_NAME`, the module's own; the function reaches it by its role, and nothing else
  is configured (no endpoint, no credential). On a laptop the compose stack runs DynamoDB Local and
  makes the table from the schema in code; `DYNAMODB_ENDPOINT` names it.
- A **public HTTPS issuer**: the module's domain (or its default endpoint). HTTPS is required for any
  consumer's verifier configuration (issuer + JWKS URL), and for Google's OAuth redirect URI when the
  deployment federates.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — the Google OIDC app (one per deployment).
  **Optional.** With no Google app configured, the browser login leg at `/oauth2/authorize` is served by
  this service's own local-credential IdP (RQ-0002) instead of redirecting to Google; setting these
  switches the same endpoint over to federation. A deployment needs one or the other — no Google app
  *and* `AUTH_LOCAL_IDP_ENABLED=false` means no interactive login at all, and `/oauth2/authorize` says so.
- `OAUTH_KEY_PASSPHRASE` — encrypts the signing keys at rest (AES-256-GCM). Required in a deployment.
- `AUTH_JWT_SECRET`, `IDENTITY_ADMIN_CLIENT_SECRET` (below), and the rest of the knobs documented in
  `service/.env.example`.

## The compose stack (a laptop)

Secrets live in a **gitignored `docker/.env`** and are **never committed**. Build context (`../service`)
and `${VAR}` interpolation resolve **locally** before the build is sent to a daemon, so the file never
leaves the operator's machine — the stack also runs against a remote Docker daemon over SSH by
pointing `DOCKER_HOST` at the host. If you front it with a shared reverse proxy, create the external
network it attaches to once (`docker network create <network-name>`).

```bash
# Dev overlay
docker compose --env-file docker/.env \
  -f docker/compose.yaml -f docker/compose.dev.yaml up -d --build
docker compose -f docker/compose.yaml -f docker/compose.dev.yaml ps

# Production overlay: swap compose.dev.yaml → compose.prod.yaml
```

The stack is DynamoDB Local (its data on a named volume), a one-shot `table-init` that makes the table
from [`service/src/db/table.ts`](../../service/src/db/table.ts), the service and the console. The image
build runs `npm run build`; the tests run in the DoD gate against DynamoDB Local (an image build has no
network to it). DynamoDB Local is published on `${DYNAMODB_PORT:-8000}` for a seed run from the host.

Seeding is an operator step whatever runs the service (RQ-0004): provisioning clients/users is
`npm run seed` against the table — see *Seed & recovery* below.

## System of record, seeding & recovery — ADR-0007 / ADR-0008

The **live table is the system of record** for the auth data (clients, users, secrets).
SOPS/seed-as-code is **dropped** (ADR-0008, superseding ADR-0006): there is no encrypted secret file in
git, and no `age` master key.

- **Bootstrap definition** — `config/seed.yaml` (committed; only `${ENV}` references, no plaintext). It
  stands up a brand-new **empty** deployment; the table is never recreated by a deploy (`prevent_destroy`),
  so steady-state data is never wiped. Day-2 changes go through the **management plane** (`/admin/v1` +
  MCP + console — ADR-0007), not a re-seed.
- **Bootstrap seed** (rare — an empty table only): supply the `${ENV}` values from the environment (an
  operator shell, or the tenant pipeline's secrets), from `service/`, against the deployment's table — a
  tenant's seed file lives in its `maestro-config-<tenant>` repository and its pipeline runs this as a
  step after apply, from the checked-out component at its tag, with the deploy role's credentials and
  the module's `table_name` output. Against the compose stack, DynamoDB Local on port `8000`:

  ```bash
  IDENTITY_ADMIN_CLIENT_SECRET=… MAESTRO_RUNTIME_CLIENT_SECRET=… SEED_ADMIN_PASSWORD=… \
    SEED_FILE=../../maestro-config-<tenant>/identity/seed.yaml \
    TABLE_NAME=identity-service DYNAMODB_ENDPOINT=http://localhost:8000 npm run seed
  ```

  Idempotent: clients are upserted; **existing users are left untouched** — change a password with
  `npm run manage-users -- set-password --email=<e> --password=<p>`. A runtime client secret
  must stay equal to its consumer-repo mirror (`MAESTRO_RUNTIME_CLIENT_SECRET` in the
  gateway/copilot/skills-coach repos, US-0086).

  The seed carries the ADR-0020 nested shape: **applications** (each with its **role catalogue** `roles:` and
  its **credentials**) and each user's **assignments** (`assignments: [{ application, roles? }]`) — see the
  [deployment-configuration guide](./tenant-config.md#application-role-catalogues--assignments-adr-0019).
  **Operator safeguard:** the bootstrap operator (`admin@identity-service.fps4.nl`) is always seeded with an
  assignment to the **`identity-console` application** granting `platform_admin`, so with global entitlement
  enforcement the console is never accidentally lockable.

### Nightly backups & point-in-time recovery — ADR-0008, ADR-0023

The **primary recovery path is a restore from a nightly backup** (it recovers the full runtime state —
issued tokens, authorizations, lockouts, signing-key history, audit log, the record's outbox and registry
— which a re-seed cannot); the table's **point-in-time recovery**, which the module turns on, is the
second line (any second of the last 35 days, restored by AWS to a new table).

**In a deployment** the module's backup Lambda ([`service/lambda/backup.ts`](../../service/lambda/backup.ts))
runs at 02:30 UTC and pages the whole table to the backup bucket as gzipped canonical JSON lines, one
file per item kind — `<prefix>/<yyyy-mm-dd>/<kind>.jsonl.gz` plus a `manifest.json` — into a versioned,
SSE-encrypted, never-public bucket that a lifecycle rule expires after `backup_retention_days` (35).
A line is the item as the table holds it, keys and all, so a restore is a `PutItem` per line. With
`backup_passphrase_secret_arn` each object is also AES-256-GCM encrypted under that passphrase
(`.jsonl.gz.enc`; `npm run backup:decrypt` undoes it). Two alarms: the backup errored; the backup did
not run. Restore with `npm run backup:restore -- <kind>.jsonl …` under credentials that may write the
table, and with the **same `OAUTH_KEY_PASSPHRASE`** the backed-up `key_store` items were encrypted under
— the README's [Backups and restore](../../README.md#backups-and-restore) has the commands.

**On a laptop** the compose stack's data is DynamoDB Local's file on the `dynamodb_data` volume; a copy of
the volume is a snapshot, and a fresh stack with an empty volume is a re-seed (RQ-0004). The retired ds1
stack's `backup.sh` (a `mongodump` of a container that no longer exists), the rename cutover and the two
one-shot data migrations of ADR-0019/0020 went with the MongoDB they operated on (ADR-0023); their
history is in git.

## Management-plane admin client & MCP server — ADR-0007

The `/admin/v1` API, the MCP server, and the admin console all authenticate with a `client_credentials`
token carrying the `admin` scope. That principal is seeded as a dedicated client
(`identity-admin-mcp`) in [`config/seed.yaml`](../../config/seed.yaml).

The **one** secret value lives in **two** places (it must be identical in both — same pattern as
`MAESTRO_RUNTIME_CLIENT_SECRET`):

- the **`IDENTITY_ADMIN_CLIENT_SECRET` environment variable** of the running service (the tenant's
  pipeline supplies it as a secret of the deployment; the compose stack reads it from `docker/.env`), so
  the in-container launcher can **mint** a token;
- the **seeded client in the live DB** → so the stored secret **hash** matches what the mint presents.

Provision it:

1. **Set it in the deployment's environment** (a secret of the tenant's pipeline, never committed).
2. **Seed the client with the same value** so it exists in the table with that secret hashed (against the
   deployment's table with a role that may write it, or the compose stack's DynamoDB Local on port `8000`;
   SOPS dropped per ADR-0008 — pass the value via the env):

   ```bash
   # from service/ (the seed upserts the identity-admin-mcp client):
   IDENTITY_ADMIN_CLIENT_SECRET=<the same value> SEED_FILE=../config/seed.yaml \
     TABLE_NAME=identity-service DYNAMODB_ENDPOINT=http://localhost:8000 npm run seed
   ```

3. **Mint a token** (any caller — the console, `curl`, a test):

   ```bash
   curl -s -XPOST https://auth.fps4.nl/oauth2/token -d grant_type=client_credentials \
        -d client_id=identity-admin-mcp -d client_secret=$IDENTITY_ADMIN_CLIENT_SECRET -d scope=admin | jq -r .access_token
   ```

   Tokens are short-lived (15 min) — mint on demand from the client id+secret rather than storing one.

### Driving the MCP server from an MCP client (e.g. Claude Code)

The MCP server talks to the table directly and verifies the admin token against the service's own JWKS, so
it runs **inside the `identity-service` container** (which already has the table, the key passphrase, and
the issuer — plus `IDENTITY_ADMIN_CLIENT_SECRET`, from the deployment's environment).
[`docker/mcp-admin.sh`](../../docker/mcp-admin.sh) mints a fresh token on each start and execs
`node dist/mcp/server.js` in that container — nothing long-lived is stored:

1. **No host-side secret is needed on ds1** — the launcher reads the secret from the container env. (For
   local/dev, or if you prefer not to inject it into the container, the launcher also accepts a host
   `IDENTITY_ADMIN_CLIENT_SECRET` env var or a `.mcp-admin.env` file next to the script, `chmod 600`.)
2. A remote MCP client connects over SSH (stdio passes straight through). The launcher lives at
   `~/identity-service/docker/mcp-admin.sh` on the ds1 host:

   ```bash
   ssh ds1 /home/fgurbanov/identity-service/docker/mcp-admin.sh
   ```

   For Claude Code, register it once at user scope so every project sees it:

   ```bash
   claude mcp add --scope user --transport stdio identity-service-admin -- ssh ds1 /home/fgurbanov/identity-service/docker/mcp-admin.sh
   ```

   The secret never leaves the ds1 host; the laptop config holds only the SSH command.

#### Remote transport — MCP over HTTP, no SSH (ADR-0009)

The stdio-over-SSH path above needs a shell account on ds1 and drops when the SSH tunnel times out.
[ADR-0009](../design/decisions/0009-remote-authenticated-mcp-service.md) adds a network-reachable
transport: the same MCP server, over **MCP Streamable HTTP**, as an OAuth-protected resource on its own
origin **`https://auth-mcp.fps4.nl/mcp`** (a Cloudflare hostname pointing at the same `:7305` service,
isolated from the token-issuing `auth.fps4.nl`) — verified through the same admin-auth + audit path.

1. **Mint an admin token *bound to the MCP resource*** (RFC 8707 audience-binding — the token is accepted
   only at `/mcp`, and a generic admin token is not), then point any MCP client at the endpoint:

   ```bash
   TOKEN=$(curl -s -XPOST https://auth.fps4.nl/oauth2/token \
     -d grant_type=client_credentials -d client_id=identity-admin-mcp \
     -d client_secret=$IDENTITY_ADMIN_CLIENT_SECRET -d scope=admin \
     -d resource=https://auth-mcp.fps4.nl/mcp | jq -r .access_token)

   claude mcp add --scope user --transport http identity-service-admin https://auth-mcp.fps4.nl/mcp \
     --header "Authorization: Bearer $TOKEN"
   ```

   A machine token is 15 minutes long-lived, so a header pasted this way stops working within the hour.
   It is the right shape for a script; for an interactive client, use the browser flow below.

2. **Discovery + browser login** (for MCP clients that run the OAuth flow themselves): the endpoint
   answers an unauthenticated request with `401 WWW-Authenticate: Bearer resource_metadata=…`, and the
   app serves `/.well-known/oauth-protected-resource` (→ the authorization server) and
   `/.well-known/oauth-authorization-server` (authorization + token endpoints, JWKS). identity-service
   is the authorization server for its own MCP resource, and it logs the operator in **itself** — ds1
   configures no Google app, so `/oauth2/authorize` serves the first-party login form (RQ-0002) and the
   resulting user token is audience-bound to the MCP resource via the client's `resource` parameter.

   The client must be **pre-registered** with the callback URI it listens on — MCP clients register
   anonymously, which gated DCR deliberately refuses (ADR-0009 §7), and a self-registered client would
   hold no `admin:*` scope anyway. `config/seed.mcp-operator.yaml` provisions exactly that credential
   (`identity-admin-mcp-operator`, public, `authorization_code`, loopback redirect on port `9414`):

   ```bash
   claude mcp add --scope user --transport http identity-service-admin https://auth-mcp.fps4.nl/mcp \
     --client-id identity-admin-mcp-operator --callback-port 9414
   ```

   `redirectUris` is exact-match validated, so `--callback-port` must equal the port in the seed file;
   change both together or not at all. The browser opens this service's own login form, and the token
   it returns is bound to the MCP resource because the client passes `resource=` (RFC 8707).

   The operator signing in needs an **active assignment** to that client's application carrying a
   `platform_admin` role (`ADMIN_OPERATOR_ROLES`) — that is what `admin-auth` maps to the `admin`
   superscope, and it, not the credential, is where the authority comes from. `seed.operators.yaml`
   provisions that for `admin@identity-service.fps4.nl`. Without it the login succeeds and the MCP call
   is still refused, by design.

Authentication is any admin-plane principal (a machine token with an admin scope, or a `platform_admin`
operator token — ADR-0010) whose `aud` includes the MCP resource; per-tool authorization is enforced
identically to the stdio + HTTP paths. Toggles: `MCP_HTTP_ENABLED` (default on), `MCP_RESOURCE_URL` (the
resource identifier), `MCP_REQUIRE_AUDIENCE` (default on — set `false` to soft-launch before clients pass
`resource`). Remaining Phase 2 hardening (DPoP/mTLS sender-constraint, step-up, dynamic registration) is
tracked in ADR-0009/RQ-0019; stdio-over-SSH stays as break-glass.

`MCP_RESOURCE_URL` names **this service's own** MCP resource and nothing else. A different product
fronting *its* MCP endpoint with this authorization server registers that endpoint in its **application's
`resources` list** (`resources:` in its seed file, or `GET/PUT /admin/v1/applications/{id}/resources`) —
see [deployment configuration](./tenant-config.md). An unregistered resource is refused `invalid_target`
at `/oauth2/authorize`, i.e. **before** the browser opens, so a misconfigured client looks like it did
nothing at all rather than like it failed to log in.

## Verify

- `GET /health` returns `{ "status": "ok" }`.
- `GET /.well-known/jwks.json` serves the RS256 public keys consumers verify against.
- A consumer's verifier env (`*_ISSUER` / `*_AUDIENCE` / `*_JWKS_URL`) must line up **exactly** with
  what this service mints — see [deployment configuration](./tenant-config.md).
