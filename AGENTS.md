# Agent guide

What an agent (or a human) must know to change this repo safely. Read `CODEBASE.md` first.

## How to run things

```bash
# DynamoDB Local — the table on a laptop (ADR-0023); the tests and the dev server both need it
docker run -d -p 8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -sharedDb -inMemory

# Service (in service/)
npm install
npm run db:create    # the table, from src/db/table.ts, on DynamoDB Local (TABLE_NAME, DYNAMODB_ENDPOINT)
npm run build        # tsc -p tsconfig.json — must stay clean
npm test             # vitest against DynamoDB Local, each file on a table of its own (run mode in CI: npm test -- --run)
npm run dev          # tsx watch src/server.ts

# SDK (in sdk/)
npm install && npm run build
```

The service listens on `PORT` (default `7305`); health at `GET /health`.

## Pre-submit checks (Definition of Done)

A change is not done until **all** of these hold (CI enforces them — `.github/workflows/dod.yml`):

- `service` and `sdk` both **build** (`npm run build`) with no type errors.
- `service` **tests pass** (`npm test -- --run`, against DynamoDB Local — the DoD job runs the container
  as a service). New behaviour ships with tests.
- Docs that describe changed behaviour are updated **in the same change** (`docs/reference/api.md`,
  `docs/guides/tenant-config.md`, `docs/design/architecture.md` as applicable).
- A change to the table's shape is made in **both** `service/src/db/table.ts` and `terraform/table.tf`;
  `tests/store.test.ts` and the boot check hold them to each other.
- The Docker image builds (`npm run build`); the Terraform gate (`terraform.yml`) formats, validates and
  tests the module and boots the bundles.

## Rules / guardrails

- **Additive, not destructive.** Never change the existing `client_credentials` grant or the JWKS
  shape — consumers (e.g. maestro) verify against them in production-shaped code.
- **One signing path.** All RS256 signing goes through the active key from `utils/key-store.ts`. Do
  not introduce a second signing path or a second JWKS.
- **Secrets never in the repo or the table.** Google client secret, key passphrase, and issuer URL come
  from env (`service/.env.example` documents every knob); the Google app's secret is service-level,
  never stored in the table. `docker/.env` is gitignored. There is no database credential at all: the
  table is reached by a role (ADR-0023).
- **`redirect_uri` is exact-match validated** against the client's registered list — never redirect
  to an unvalidated URI.
- **Token contract is load-bearing.** User tokens MUST carry `email`, the stable `sub`, `iss`, a
  per-consumer `aud`, and `exp` — a consumer rejects anything else. Keep tests that verify a token
  the way a consumer does (signature via JWKS, `iss`/`aud`/`exp` enforced). Every token also carries
  `prn`, the maestro principal id (ADR-0022) — additive, and the id maestro's record names.
- **An act on the registry is recorded or not performed (ADR-0022).** A mutating operation on users,
  credentials or assignments takes the act context (who is acting) and emits the spine envelope in the
  same transaction (`withRecordTransaction`, one `TransactWriteItems` — ADR-0023); never write these
  items around the service layer, and never put a name, an email, a subject or free text in an event body.
- **Every access path is a key or an index (ADR-0023).** Nothing outside `service/src/db/` builds a key,
  an expression or an SDK command; a new query is a method on the store, and a new index is a change to
  `table.ts` and `table.tf` together. The service never scans.

## Code style

- TypeScript ESM (`"type": "module"`); imports use the `.js` extension on relative paths (NodeNext).
- Dependency-inject I/O (the store, Google IdP, clock) so logic is testable — mirror the existing
  `OAuthServerDependencies` pattern; tests pass a store over a table of their own and stub the IdP.
- Match the surrounding code's naming and comment density; explain *why*, not *what*.
