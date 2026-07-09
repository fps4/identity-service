---
title: Product-runtime credential (client_credentials)
status: current
last_updated: 2026-06-11
owners: [architect]
related:
  - docs/reference/api.md
  - docs/guides/tenant-config.md
  - docs/product/RQ-0004-seed-config-provisioning.md
---

# Product-runtime credential (`client_credentials`)

A **managed product's runtime** authenticates to maestro's runtime-intake endpoints (heartbeat,
telemetry, RCA) as a `product_runtime` principal. It obtains that credential from identity-service's
existing OAuth2 `client_credentials` grant — one registered client per deployment — so a deployment
configures a `client_id` + `client_secret` and exchanges them for a short-lived, signed JWT that
maestro verifies against this service's JWKS (maestro US-0086).

This is the same grant CI clients use; the only additions (US-0086) are **per-client audience**,
**`subject`**, and **additive `claims`**, so the minted token carries exactly what the resource
server (maestro) matches on.

## What the token carries

For a deployment registered as the client below, `POST /oauth2/token` with
`grant_type=client_credentials` mints an RS256 JWT with:

| Claim   | Source                              | Example                                  |
| ------- | ----------------------------------- | ---------------------------------------- |
| `aud`   | client `audience`                   | `maestro-workspace`                      |
| `sub`   | client `subject` (← else client id) | `runtime@sovereign-llm-gateway.fps4.nl`  |
| `role`  | client `claims.role`                | `product_runtime`                        |
| `email` | client `claims.email`               | `runtime@sovereign-llm-gateway.fps4.nl`  |
| `iss`   | service `AUTH_JWT_ISSUER`           | `https://auth.fps4.nl`                   |
| `exp`   | `accessTokenTtlSec`                 | short-lived                              |

maestro resolves the deployment by `email`/`sub` against its register and checks `aud` +
`role` (the register is authoritative; `role` is defence-in-depth). Registered claims
(`iss`/`aud`/`exp`/`sub`) are always set by the signer — a value smuggled into `claims` can never
override them.

## Registering a runtime client (self-registration — ADR-0017)

> **Changed (ADR-0017 / RQ-0018).** A **managed product** no longer registers its runtime client in
> identity-service's `config/seed.yaml`. Embedding each product's `secret: ${MAESTRO_*_DS1_SECRET}`
> there coupled identity-service's all-or-nothing bootstrap to other products' secrets and wedged the
> ds1 seed (see [ds1 delivery-pipeline findings](../guides/ds1-delivery-pipeline-findings.md)). Instead
> each product **self-registers** its runtime client through the management plane and receives the
> secret **once**. identity-service's *own* runtime client is the only one still seeded (its secret is
> identity-service-owned).

The flow (ADR-0017):

1. **An identity-service operator mints a client-registration invite** (management plane —
   `/admin/v1`, MCP, or console) that *pins* the client's shape: `clientId`, `name`,
   `audience` (`maestro-workspace`), `subject` (`runtime@<product>.fps4.nl`), and
   `claims:{role: product_runtime, email: …}`. `grantTypes` is fixed to `[client_credentials]`. The
   operator sends the one-time code to the product team out-of-band.
2. **The product redeems the code** at the public, code-gated `POST /v1/clients/register`. Redemption
   creates the pinned client (or rotates its secret) and returns the `client_secret` **once**. The
   redeemer cannot alter the pinned shape — it self-serves the *secret*, never the *privilege*.
3. **The product stores that secret in its OWN vault** (its repo's Actions secrets / runtime env) — it
   never lives in identity-service's seed or Actions secrets. Rotation is a fresh invite (or a re-redeem
   of a multi-use one).

Because the secret lives only as a DB hash plus the product's own copy, there is no seed value to drift
against. See [ADR-0017](../design/decisions/0017-product-runtime-self-registration-invites.md) and
[RQ-0018](../product/RQ-0018-product-runtime-self-registration.md) for the model, the shape-pinning
rule, and atomic create-or-rotate redemption.

### identity-service's own runtime client (still seeded)

identity-service's own telemetry runtime *is* still declared in `config/seed.yaml`, because its secret
(`${MAESTRO_RUNTIME_CLIENT_SECRET}`) is identity-service-owned and is the same value the running service
presents to self-mint — so seed and runtime cannot drift:

```yaml
      - id: identity-service-ds1-runtime
        name: identity-service@ds1 runtime
        grantTypes: [client_credentials]
        isConfidential: true
        secret: ${MAESTRO_RUNTIME_CLIENT_SECRET}   # identity-service-owned; the SAME value the runtime presents
        audience: maestro-workspace                # must equal maestro's IDENTITY_SERVICE_AUDIENCE
        subject: runtime@identity-service.fps4.nl
        claims:
          role: product_runtime
          email: runtime@identity-service.fps4.nl
```

## Exchanging the credential

```bash
curl -s -X POST https://auth.fps4.nl/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id=sovereign-llm-gateway-ds1 \
  -d client_secret="$GATEWAY_DS1_RUNTIME_SECRET"
# → { "access_token": "<jwt>", "token_type": "Bearer", "expires_in": …, "scope": "" }
```

The managed-product SDK does this for you — see its `client_credentials` token provider, which caches
the token and refreshes it before expiry, and stays dormant when no credential is configured.
