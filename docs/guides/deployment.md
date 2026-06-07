---
title: Deployment
status: current
last_updated: 2026-06-07
owners: [architect]
related:
  - docs/design/architecture.md
  - docs/guides/tenant-config.md
---

# Deployment

How component-auth is deployed. The service is a **stateless container** driven entirely by environment
variables, with **MongoDB** as its only persistent dependency. It can run anywhere Docker runs; the
default pattern is a **manual deploy over SSH to a Docker host**.

## Prerequisites on the host

- **Docker** with Compose v2.
- A reachable **MongoDB** (provisioned by the compose stack, or external — set `MONGO_URI`).
- An **external Docker network** the service attaches to, if you front it with a shared reverse proxy
  (create it once: `docker network create <network-name>`; reference it from the compose overlay).
- A **public HTTPS endpoint** (reverse proxy, ingress, or tunnel) terminating TLS in front of the
  service. HTTPS is required both for Google's OAuth redirect URI and for any consumer's verifier
  configuration (issuer + JWKS URL). The service itself listens on `PORT` (default `7305`).

## Secrets

Secrets live in a **gitignored `docker/.env`** and are **never committed**:

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — the Google OIDC app (service-level, not per tenant).
- `OAUTH_KEY_PASSPHRASE` — optional AES-256-GCM encryption of signing keys at rest.
- `AUTH_JWT_ISSUER` — the public HTTPS issuer URL; becomes the token `iss`.
- `MONGO_URI` and the rest of the knobs documented in `service/.env.example`.

Build context (`../service`) and `${VAR}` interpolation resolve **locally** before the build is sent to
the remote daemon, so the gitignored `docker/.env` never leaves the operator's machine.

## Deploy

Run Compose against a remote Docker daemon over SSH by pointing `DOCKER_HOST` at the target host:

```bash
# Deploy from a workstation against the remote daemon over SSH
export DOCKER_HOST=ssh://<deploy-host>

# Dev overlay
docker compose --env-file docker/.env \
  -f docker/compose.yaml -f docker/compose.dev.yaml up -d --build
docker compose -f docker/compose.yaml -f docker/compose.dev.yaml ps

# Production overlay: swap compose.dev.yaml → compose.prod.yaml
```

The image build runs `npm run build && npm test`, so a type error or a red test **fails the deploy**.

## CI-driven deploys (optional)

A GitHub Actions self-hosted-runner workflow exists but is **disabled** — kept fully commented in
`.github/workflows/deploy.yml` so it can be restored if the project moves back to CI-driven deploys.

## Verify

- `GET /health` returns `{ "status": "ok" }`.
- `GET /.well-known/jwks.json` serves the RS256 public keys consumers verify against.
- A consumer's verifier env (`*_ISSUER` / `*_AUDIENCE` / `*_JWKS_URL`) must line up **exactly** with
  what this service mints — see [`tenant-config.md`](./tenant-config.md).
