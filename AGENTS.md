# Agent guide

What an agent (or a human) must know to change this repo safely. Read `CODEBASE.md` first.

## How to run things

```bash
# Service (in service/)
npm install
npm run build        # tsc -p tsconfig.json — must stay clean
npm test             # vitest (run mode in CI: npm test -- --run)
npm run dev          # tsx watch src/server.ts

# SDK (in sdk/)
npm install && npm run build
```

The service listens on `PORT` (default `7305`); health at `GET /health`.

## Pre-submit checks (Definition of Done)

A change is not done until **all** of these hold (CI enforces them — `.github/workflows/dod.yml`):

- `service` and `sdk` both **build** (`npm run build`) with no type errors.
- `service` **tests pass** (`npm test -- --run`). New behaviour ships with tests.
- Docs that describe changed behaviour are updated **in the same change** (`docs/reference/api.md`,
  `docs/guides/tenant-config.md`, `docs/design/architecture.md` as applicable).
- The Docker image builds — its build runs `npm run build && npm test`, so a red test fails the deploy.

## Rules / guardrails

- **Additive, not destructive.** Never change the existing `client_credentials` grant or the JWKS
  shape — consumers (e.g. maestro) verify against them in production-shaped code.
- **One signing path.** All RS256 signing goes through the active key from `utils/key-store.ts`. Do
  not introduce a second signing path or a second JWKS.
- **Secrets never in the repo or the DB.** Google client secret, key passphrase, and issuer URL come
  from env (`service/.env.example` documents every knob); the Google app's secret is service-level,
  never stored in the database. `docker/.env` is gitignored.
- **`redirect_uri` is exact-match validated** against the client's registered list — never redirect
  to an unvalidated URI.
- **Token contract is load-bearing.** User tokens MUST carry `email`, the stable `sub`, `iss`, a
  per-consumer `aud`, and `exp` — a consumer rejects anything else. Keep tests that verify a token
  the way a consumer does (signature via JWKS, `iss`/`aud`/`exp` enforced).

## Code style

- TypeScript ESM (`"type": "module"`); imports use the `.js` extension on relative paths (NodeNext).
- Dependency-inject I/O (Mongo connection, Google IdP, clock) so logic is testable without network —
  mirror the existing `OAuthServerDependencies` pattern; tests pass stubs.
- Match the surrounding code's naming and comment density; explain *why*, not *what*.
