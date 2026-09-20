# identity-service

A standalone identity service (a self-hosted IdP) shared across products — one deployment is one realm
with a single shared user pool ([ADR-0018](docs/design/decisions/0018-collapse-tenant-into-deployment.md)). It ships the
service (OAuth 2.0 + OIDC token issuance), a headless SDK, an optional drop-in React `<Login/>`, an
authenticated management plane (HTTP `/admin/v1` + an MCP server for agents), and an optional operator
admin console. It owns **authentication** (who you are); consuming products keep their own
**authorization** (what you may do).

## Project Layout

```
identity-service/
 ├── docker/           # Docker Compose base + overrides (the development loop); backup.sh (nightly backups)
 ├── terraform/        # The deployment: a Terraform module — service on Lambda behind an HTTP API, backups
 ├── service/          # REST API + Docker assets
 │    ├── src/         # Express app, OAuth + session cores, admin plane, MCP server, models
 │    ├── lambda/      # The backup Lambda (outside src/: it is the deployment's, not the service's)
 │    ├── scripts/     # Operator CLIs (seed, manage-users) and bundle.mjs (the Lambda bundles)
 │    ├── Dockerfile   # Container build
 ├── sdk/              # Headless TypeScript client for the API
 │    └── src/
 ├── react/            # Optional React UI: drop-in <Login/> (@fps4/identity-service-react)
 │    └── src/
 ├── console/          # Optional operator admin console (Next.js, @fps4/identity-service-console)
 │    └── app/
 ├── config/           # seed.example.yaml → seed.yaml (gitignored): applications (+role catalogues + credentials) + users + assignments
 ├── docs/             # Two-plane docs: design/ · reference/ · guides/ · product/ (index: docs/README.md)
 └── README.md
```

## Quick Start

1. Copy `service/.env.example` to `.env` and set values:
   - `MONGO_URI`, `MONGO_DB_NAME`
   - `AUTH_JWT_SECRET`, `AUTH_JWT_ISSUER`, `AUTH_JWT_AUDIENCE`
   - OAuth settings: token TTLs, deployment limits, optional key passphrase (see comments in `.env.example`)
   - Optionally update `SESSION_TTL_MINUTES`, `CORS_ORIGINS`
2. Install dependencies & build:

   ```bash
   cd service
   npm install
   npm run build
   npm test
   npm start
   ```

3. (Optional) Run with Docker:

   ```bash
   docker compose -f docker/compose.yaml -f docker/compose.dev.yaml up --build
   ```
   Use `docker compose -f docker/compose.yaml -f docker/compose.dev.yaml down` to stop containers.

The service listens on `PORT` (default `7305`). Health check at `GET /health`.

## API Summary

- `POST /oauth2/token` – client credentials grant issuing RS256 access tokens.
- `GET /.well-known/jwks.json` – JWKS for verifying issued tokens.
- `POST /v1/sessions` – persist session, issue legacy session JWT (in migration).
- `PATCH /v1/sessions/:sessionId` – attach contact identifiers or cookie context.
- `/admin/v1/*` – the authenticated **management plane** (ADR-0007): **applications** (their role catalogues, members, and credentials — ADR-0020), **credentials** (OAuth clients under an application), users, **assignments** (user↔app entitlements — ADR-0019), invites, signing keys, stats, and audit. Network-restricted, scoped per actor, append-only audited. The same operations are exposed to agents over an **MCP server** (`npm run mcp`).
- See `docs/reference/api.md` for full payloads and responses.

## SDK Usage

```ts
import { ComponentAuthClient } from '@fps4/identity-service-sdk';

const client = new ComponentAuthClient({
  baseUrl: 'https://auth.example.com'
});

const session = await client.createSession({ visitorId: 'visitor-001' });
await client.updateSession({ sessionId: session.sessionId, contactId: 'contact-42' });

const token = await client.requestClientCredentialsToken({
  clientId: process.env.CORE_AUTH_CLIENT_ID!,
  clientSecret: process.env.CORE_AUTH_CLIENT_SECRET!,
  scope: ['telemetry:write']
});

console.log(token.accessToken);
```

### Browser login (RQ-0001 Google SSO / RQ-0002 local credentials)

A browser frontend drives the redirect login with PKCE and forwards the issued token as
`Authorization: Bearer` to its own API. The SDK calls are named for Google because that was the first
IdP, but the flow is provider-agnostic: `/oauth2/authorize` redirects to Google when the deployment
configures a Google app, and otherwise serves this service's own login form. The consumer's half —
`beginGoogleLogin` → navigate → `completeGoogleLogin` — is identical either way.

```ts
// 1. Begin: stash the verifier/state, then navigate to the authorization endpoint.
const { authorizationUrl, codeVerifier, state } = await client.beginGoogleLogin({
  clientId: 'client-maestro',
  redirectUri: 'https://app.example.com/auth/callback'
});
sessionStorage.setItem('pkce', JSON.stringify({ codeVerifier, state }));
window.location.assign(authorizationUrl);

// 2. On the redirect back (…/auth/callback?code=…&state=…): exchange the code.
const { codeVerifier, state } = JSON.parse(sessionStorage.getItem('pkce')!);
if (params.get('state') !== state) throw new Error('state mismatch');
const token = await client.completeGoogleLogin({
  code: params.get('code')!,
  codeVerifier,
  redirectUri: 'https://app.example.com/auth/callback',
  clientId: 'client-maestro'
});
// token.accessToken → send as `Authorization: Bearer`; token.refreshToken → client.refreshUserToken(...)
```

Run `npm install && npm run build` inside `sdk/` to compile distributable assets. Consumers need a `fetch` implementation (Node 18+ or polyfill); the login helpers also require WebCrypto (browser or Node 18+).

### React login component

For React consumers, `@fps4/identity-service-react` (in `react/`) ships a drop-in `<Login/>` for the
local email/password IdP — so apps don't rebuild the form. It's a **separate, opt-in** package (React
peer dependency only); the headless SDK stays UI-free.

```tsx
import { Login } from '@fps4/identity-service-react';

<Login
  baseUrl="https://auth-dev.example.com"
  clientId="client-local"
  onSuccess={(token) => sessionStorage.setItem('access_token', token.accessToken)}
/>
```

See [`react/README.md`](react/README.md) for styling (Tailwind/shadcn) and the full API.

### Operator admin console

For day-2 operations, `@fps4/identity-service-console` (in `console/`) is an **optional** Next.js app — a
thin server-side client over the `/admin/v1` management plane (ADR-0007): dashboards plus **application**
(with role-catalogue, members, and credentials — ADR-0020), user, assignment, and signing-key management.
The admin bearer token stays in server env and never reaches the browser; no direct database access.
Distinct from the consumer-facing `<Login/>` widget. See [`console/README.md`](console/README.md).

## Docs

Docs follow a two-plane structure — see [`docs/README.md`](docs/README.md) for the full index, or
[`docs/overview.md`](docs/overview.md) for the landing.

- [`docs/design/architecture.md`](docs/design/architecture.md) – overall architecture, OAuth components, and the management plane.
- [`docs/reference/api.md`](docs/reference/api.md) – endpoint contract (incl. `/admin/v1`) and token shape.
- [`docs/guides/tenant-config.md`](docs/guides/tenant-config.md) – deployment configuration & OAuth clients.
- [`docs/guides/deployment.md`](docs/guides/deployment.md) – how the service is deployed, plus nightly backups & recovery.
- [`console/README.md`](console/README.md) – the optional operator admin console over `/admin/v1`.
- [`docs/product/`](docs/product) – the `RQ-*` functional specs (e.g. `RQ-0001` adds user identity via Google SSO, issued as a verifiable JWT).
- [`docs/design/decisions/`](docs/design/decisions) – architecture decision records (ADRs).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) – how to build & test the packages.
- `tests/` – manual harness + scripts for integration checks on deployed environments.

## Deployments

The service is a **stateless container** with **MongoDB** as its only persistent dependency; the
`docker/` compose stack runs it on a laptop (secrets in a **gitignored `docker/.env`** — never
committed) and is the development loop, not a deployment target. The service listens on `PORT` (default
`7305`). The image build runs `npm run build && npm test`, so a red test fails the build.

Deployment is serverless AWS as the Terraform module in [`terraform/`](terraform/), composed by a
tenant's private configuration repository (`fps4/maestro-config-<tenant>` —
[`maestro/docs/tenancy-and-config.md`](https://github.com/fps4/maestro/blob/main/docs/tenancy-and-config.md)) and applied by the
tenant's own pipeline; maestro's ADR-0016 and ADR-0017. Nothing in this repository deploys anywhere —
its CI runs on GitHub-hosted runners and ends at the gate ([`terraform.yml`](.github/workflows/terraform.yml):
`fmt`, `validate`, `terraform test` against a mocked provider, the bundles built and booted) — and the
earlier self-hosted deploy, seed and migration workflows are gone.

### What the module deploys

| Piece | |
|---|---|
| Service | the Express server, unchanged, as a Lambda function (Node 22, arm64) behind the [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) layer, behind an HTTP API Gateway with one `$default` route; one realm per deployment. `RECORD_SINK=off`: it writes the outbox and relays nothing in-process — the relay below is the one relay |
| Database | the tenant's MongoDB Atlas cluster, named by `MONGO_URI` (maestro ADR-0005); the module creates none |
| Signing keys | generated on first use and kept in the database's `key_store`, AES-256-GCM under `OAUTH_KEY_PASSPHRASE` — nothing on disk, so Lambda needs no change and the function's role is logs only |
| Relay | a scheduled Lambda (every minute, one invocation at a time) runs the spine's relay handler over this service's outbox ([ADR-0022](docs/design/decisions/0022-maestro-principal-ids-and-lifecycle-events.md) §5) into the archive bucket and the FIFO topic the spine's module owns; its role is its log plus the spine's `relay_policy_json`, attached unchanged; its one secret is `MONGO_URI` |
| Backups | a scheduled Lambda (02:30 UTC nightly) writes every collection to a versioned, encrypted, never-public S3 bucket; expires by a lifecycle rule; alarms on an error and on silence |
| Alarms | API 5xx (≥ 5 in 5 min); backup errors (≥ 1 in a day), backup silent (no invocation in a day — missing data breaches); relay errors (≥ 1 in an hour), relay silent (no invocation in 15 min — missing data breaches), relay refused (the spine refused an event — `maestro/spine` `Refused`, `function=relay`, `component=identity`; that workspace's relay is stopped until a person looks) |
| Console | **not in the module** — see [the console](#the-console) below |

**Bundles.** `npm run bundle` in `service/` (Node 22) esbuilds the server to `bundle/service.zip` — one
`index.mjs` plus `run.sh` for the Web Adapter's zip mode — the backup to `bundle/backup.zip` and the relay
([`service/src/relay/lambda.ts`](service/src/relay/lambda.ts)) to `bundle/relay.zip`; reproducibly, so
`source_code_hash` only changes when the code does. `npm run bundle:smoke` imports the relay bundle and
checks it exports its `handler`, then boots the service bundle against a port nothing listens on and
checks it dies of a connection failure and not a missing module; `npm run sbom` writes a CycloneDX SBOM
per bundle (`bundle/*.cdx.json`, production dependencies only). `bundle/` is gitignored; the tenant's
pipeline builds it at the tag it deploys.

### Inputs

| Input | Default | |
|---|---|---|
| `name` | `maestro-identity` | prefix for every named resource |
| `service_package`, `backup_package`, `relay_package` | required | the zips from `npm run bundle` |
| `web_adapter_layer_arn` | required | the arm64 Web Adapter layer in the deployment's region: `arn:aws:lambda:<region>:<aws-account>:layer:LambdaAdapterLayerArm64:<version>`, from [the adapter's README](https://github.com/awslabs/aws-lambda-web-adapter#lambda-functions-packaged-as-zip-package-for-aws-managed-runtimes). It carries AWS's account id, which a public repository may not hold — so an input, in the tenant's tfvars |
| `environment` | `{}` | every non-secret variable the service reads ([`service/.env.example`](service/.env.example)): `MONGO_DB_NAME`, `AUTH_JWT_AUDIENCE`, `CORS_ORIGINS`, `AUTH_REGISTRATION_MODE`, `AUTH_LOCAL_IDP_ENABLED`, `ADMIN_OPERATOR_ROLES`, `GOOGLE_CLIENT_ID`, `LOG_LEVEL`, the `OAUTH_*` limits — and the record's: `MAESTRO_WORKSPACE_ID` (this realm's workspace on maestro's record, `ws-<realm slug>`; the service's default `ws-identity-dev` is a laptop's), `MAESTRO_ACCOUNTABLE` (the `prn-h-…` of the human answerable for machine actors' acts; without it an agent or a pipeline acting through the management plane is refused — ADR-0022 §4) and `MAESTRO_CONSEQUENCE_CLASS` (`c1` by default). The relay gets the same map. The module sets `NODE_ENV` and `LOG_PRETTY` (a key here overrides them) and `AUTH_JWT_ISSUER`, `GOOGLE_REDIRECT_URI`, `RECORD_SINK=off` and the adapter's variables (nothing overrides those) |
| `secrets` | required | variable → Secrets Manager ARN: `MONGO_URI` (required), `AUTH_JWT_SECRET`, `OAUTH_KEY_PASSPHRASE`, `IDENTITY_ADMIN_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET` when Google federates. All reach the service; the backup and the relay get `MONGO_URI` only |
| `domain`, `certificate_arn` | `null` | the realm's hostname and its ACM certificate (same region); the root aliases DNS to the `domain_target` output |
| `archive` | required | `{ relay_environment = module.spine.relay_environment, relay_policy_json = module.spine.relay_policy_json }` — the spine module's outputs, passed through: the three names the relay reads (`ARCHIVE_BUCKET`, `ARCHIVE_PREFIX`, `EVENTS_TOPIC_ARN`) and what its role may do. Required because the record is not optional: without an archive the outbox is never drained |
| `relay_schedule` | `rate(1 minute)` | EventBridge Scheduler expression; the latency between an act and its record |
| `relay_memory_mb`, `relay_timeout_seconds` | `512`, `300` | one pass drains the outbox until it is empty |
| `backup_bucket_name` | required | globally unique; the tenant's to choose |
| `backup_prefix` | `backups` | key prefix; a day's backup is `<prefix>/<yyyy-mm-dd>/` |
| `backup_retention_days` | `35` | lifecycle expiry of backups and their noncurrent versions |
| `backup_schedule` | `cron(30 2 * * ? *)` | EventBridge Scheduler expression, UTC |
| `backup_passphrase_secret_arn` | `null` | when set, every backup object is also AES-256-GCM encrypted under the passphrase in that secret |
| `memory_mb`, `timeout_seconds` | `1024`, `29` | the service function; 29 s is the ceiling under the HTTP API's 30 s integration timeout |
| `backup_memory_mb`, `backup_timeout_seconds` | `1024`, `900` | the backup buffers each collection compressed in memory |
| `log_retention_days` | `90` | |
| `alarm_actions` | `[]` | ARNs the alarms notify — the tenant's ops-signals topic |
| `tags` | `{}` | |

Outputs: `api_url`, `issuer`, `domain_target`, `service_function_name`, `backup_function_name`,
`relay_function_name`, `backup_bucket_name`, `backup_prefix`, `api_id`.

### A root, composing it

The tenant's `deploy/aws/` root, with placeholders ([`terraform/examples/demo`](terraform/examples/demo)
is the same with the demo tenant's values; `terraform init -backend=false && terraform validate` there
fetches the spine's module at its tag):

```hcl
module "spine" {                                    # the archive, the events topic, the sealer
  source              = "github.com/fps4/maestro//spine/terraform?ref=spine-v0.2.2"
  name                = "<tenant>"
  archive_bucket_name = "<tenant>-maestro-archive"
  archive_prefix      = "identity/"
  digest_contacts     = ["ops@<tenant-domain>"]
  sealer_package      = "../../../maestro/spine/bundle/sealer.zip"
}

module "identity" {
  source = "../../../identity-service/terraform"   # the component, checked out at its tag

  name                  = "<tenant>-identity"
  service_package       = "../../../identity-service/service/bundle/service.zip"
  backup_package        = "../../../identity-service/service/bundle/backup.zip"
  relay_package         = "../../../identity-service/service/bundle/relay.zip"
  web_adapter_layer_arn = var.web_adapter_layer_arn # tfvars

  domain          = "id.<tenant-domain>"
  certificate_arn = var.identity_certificate_arn    # tfvars

  environment = {
    MONGO_DB_NAME          = "identity-service"
    AUTH_JWT_AUDIENCE      = "maestro"
    CORS_ORIGINS           = "https://maestro.<tenant-domain>"
    AUTH_REGISTRATION_MODE = "invite"
    AUTH_LOCAL_IDP_ENABLED = "true"
    ADMIN_OPERATOR_ROLES   = "platform_admin"
    MAESTRO_WORKSPACE_ID   = "ws-<tenant>"          # this realm on maestro's record
    MAESTRO_ACCOUNTABLE    = "prn-h-…"              # who answers for the realm's own automation
  }
  secrets = {                                       # names from the tenant's secrets.md
    MONGO_URI                    = aws_secretsmanager_secret.identity_mongo_uri.arn
    AUTH_JWT_SECRET              = aws_secretsmanager_secret.identity_jwt_secret.arn
    OAUTH_KEY_PASSPHRASE         = aws_secretsmanager_secret.identity_key_passphrase.arn
    IDENTITY_ADMIN_CLIENT_SECRET = aws_secretsmanager_secret.identity_admin_client_secret.arn
  }

  archive = {                                       # the spine module's outputs, passed through
    relay_environment = module.spine.relay_environment
    relay_policy_json = module.spine.relay_policy_json
  }

  backup_bucket_name = "<tenant>-identity-backups"
  alarm_actions      = [module.spine.digests_topic_arn]
}

resource "aws_route53_record" "identity" {
  zone_id = var.zone_id
  name    = "id.<tenant-domain>"
  type    = "A"
  alias {
    name                   = module.identity.domain_target.name
    zone_id                = module.identity.domain_target.zone_id
    evaluate_target_health = false
  }
}
```

**The issuer.** `AUTH_JWT_ISSUER` is the `iss` of every token and what every consumer's verifier is
configured with, so it must not change. The module sets it itself and outputs it as `issuer`: with a
`domain`, `https://<domain>`; without one, the API's default endpoint
(`https://<api-id>.execute-api.<region>.amazonaws.com`, the `$default` stage has no path) — the API
resource is created before the function, so the function's environment can carry the endpoint without a
cycle, and a root need not feed it back. But that endpoint is an id AWS assigns: recreate the API and
it, `iss`, and every verifier change with it. Use a domain for anything past a trial. `MCP_RESOURCE_URL`
defaults to `<issuer>/mcp` in the service and `GOOGLE_REDIRECT_URI` to `<issuer>/oauth2/callback` in
the module.

**Secrets.** The module reads each secret at plan time (`data.aws_secretsmanager_secret_version`) and
sets it on the function, which is what any secret in a Lambda environment is: readable by whoever can
read the function's configuration or the Terraform state. The state bucket is what protects it
(ADR-0017 — versioned, private, the deploy role and break-glass only). The follow-up is the Parameters
and Secrets Lambda extension with the service reading its configuration through it at boot; that is a
change to `service/src/config.ts`, and the module then grants `secretsmanager:GetSecretValue` on the
listed ARNs instead of setting values. `MONGO_URI` is the connection string without a path or query —
the service appends `/<MONGO_DB_NAME>`.

**The record.** The registry emits its lifecycle — `PrincipalRegistered`, `PrincipalSuspended`,
`PrincipalReinstated`, `SeatOccupancyChanged` — as spine envelopes into a transactional outbox
([ADR-0022](docs/design/decisions/0022-maestro-principal-ids-and-lifecycle-events.md)). On AWS the
service runs with `RECORD_SINK=off`, set by the module and not overridable: it writes the outbox and relays
nothing in-process. The relay function drains it every minute (`relay_schedule`), one invocation at a
time, into the archive and the FIFO topic named by `archive` — the spine module's `relay_environment` and
`relay_policy_json`, passed through unchanged. A refused event stops that workspace's relay where it
stands, by design, and raises `<name>-relay-refused`; relay lag raises `<name>-relay-silent`. `archive` is
required: a deployment without one would write an outbox nothing ever drains.

### Seeding a realm

Seeding is `npm run seed` from `service/` against the deployment's database (RQ-0004): it reads a YAML
seed and the `${ENV}` secrets it names from the process environment, and it is idempotent. The tenant's
seed lives in `fps4/maestro-config-<tenant>` (the realm's applications, credentials, operators — the
[deployment guide](docs/guides/deployment.md) has the shape), and the tenant's pipeline runs it as a step
after apply, from the checked-out component at its tag:

```bash
cd identity-service/service && npm ci
SEED_FILE=../../maestro-config-<tenant>/identity/seed.yaml \
  MONGO_URI=$MONGO_URI MONGO_DB_NAME=identity-service \
  IDENTITY_ADMIN_CLIENT_SECRET=… SEED_ADMIN_PASSWORD=… npm run seed
```

The runner's egress address must be on the Atlas cluster's IP access list (fps4's own tenant runs on
the ds1 runner, which is). Not a Lambda: the seed is a rare operator step that takes a file and a
handful of secrets that are the seed's, not the service's — packaging both per tenant into a third
bundle and a second secrets path buys nothing over the one command the compose stack already documents,
and a person holding the role runs the same command from a laptop (ADR-0004).

### Backups and restore

The backup Lambda ([`service/lambda/backup.ts`](service/lambda/backup.ts)) connects with the driver and
writes every collection as gzipped **canonical Extended JSON lines** — one object per collection under
`<prefix>/<yyyy-mm-dd>/<collection>.jsonl.gz`, plus `manifest.json` (document counts, sizes, SHA-256s).
Canonical means every BSON type is kept as it was, so a restore is the same documents. It replaces
`docker/backup.sh`'s `mongodump` for a deployment: a Lambda has no `mongodump`, and `mongoimport` reads
this format. With `backup_passphrase_secret_arn` each object is additionally AES-256-GCM encrypted under
the passphrase (scrypt-derived key, the construction the signing keys use) and named `.jsonl.gz.enc`;
without it the bucket — SSE, versioned, never public, TLS-only, written by a role that can only
`PutObject` under the prefix — is the protection, as the plaintext path of ADR-0008 was. Restore:

```bash
aws s3 sync s3://<bucket>/backups/<yyyy-mm-dd>/ ./restore/ && cd restore
BACKUP_PASSPHRASE=… npm --prefix ../identity-service/service run backup:decrypt -- users.jsonl.gz.enc users.jsonl.gz   # .enc only
gunzip *.jsonl.gz
for c in *.jsonl; do mongoimport --uri "$MONGO_URI/identity-service" --collection "${c%.jsonl}" --drop --file "$c"; done
```

`key_store` holds the signing keys encrypted under `OAUTH_KEY_PASSPHRASE`: restore with the same
passphrase or the realm cannot sign. Backups are recovery points, not the record — the bucket has no
Object Lock and a lifecycle rule expires them.

### The console

The operator console (`console/`, Next.js 15) is **not deployed by this module**. It builds with
OpenNext (`npx @opennextjs/aws build` produces a server function, an image optimiser, a revalidation
queue and a DynamoDB tag cache), but the community Terraform module for it
(`RJPearson94/open-next/aws`, v3.7) documents OpenNext v2 and v3 while `@opennextjs/aws` is at 4.x,
needs the AWS provider ≥ 6.29 configured five times (`server_function`, `iam`, `dns`, `global`) plus
the `archive` and `local` providers, and uploads assets and mutates resources through bash + AWS CLI
`local-exec` scripts — outside `plan` as the review artefact (ADR-0016) and beyond what a mocked provider
or LocalStack can prove. Its `NEXT_PUBLIC_*` values are also baked at build time, so it is built per
tenant after the issuer is fixed. The console is a surface; the API and JWKS are what M1 needs. It
follows as its own module once a tenant can apply it against a real account — a single Lambda behind
CloudFront is likely enough for a console with no ISR and no images.

See [`docs/guides/deployment.md`](docs/guides/deployment.md) for the short form, provisioning the
management-plane admin client and MCP server, and how a consumer's verifier env lines up with what the
service mints.
