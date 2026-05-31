# Component Auth API

The service exposes OAuth 2.0 endpoints under `/oauth2/*` and legacy session routes under `/v1/*`. Responses are JSON unless noted otherwise.

## Authentication

The service currently relies on network-level controls (private network, API gateway, etc.). Downstream consumers can optionally send an `Authorization` header; the service will pass it to logging middleware but does not verify it yet.

## Headers

- `Content-Type: application/json`
- `Origin` – used to enforce CORS per tenant.

---

## `POST /oauth2/token`

Issue OAuth 2.0 access tokens. Currently only the **client credentials** grant is supported.

> **Prerequisite:** the tenant must have `oauth.enabled = true` and allow the `client_credentials` grant. See [Tenant Configuration](tenant-config.md).

### Request

- `Content-Type: application/x-www-form-urlencoded`
- Client authentication via HTTP Basic (`Authorization: Basic base64(client_id:client_secret)`) **or** `client_id` and `client_secret` form fields.
- Body parameters:
  - `grant_type=client_credentials`
  - `scope` (optional, space-delimited string; subset of client’s registered scopes)

### Response (`200`)

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "telemetry:write telemetry:read"
}
```

### Errors

- `400 invalid_request` – missing grant_type.
- `400 invalid_scope` – requested scope not permitted.
- `401 invalid_client` – bad client credentials.
- `400 unauthorized_client` – grant not allowed for client.
- `429 slow_down` – tenant token rate limit exceeded.
- `500 server_error` – unexpected failure.

---

## `POST /v1/tenants/{tenantId}/sessions`

Create a session and issue a tenant-scoped JWT (legacy path; tokens will align with OAuth responses in a future release).

### Path Parameters

- `tenantId` – required tenant identifier.

### Request Body

```json
{
  "visitorId": "optional string",
  "subject": "optional string",
  "clientMeta": {
    "ip": "1.2.3.4",
    "userAgent": "Mozilla/5.0"
  }
}
```

`clientMeta` is optional; headers such as `User-Agent`, `Sec-CH-UA*`, and `X-Forwarded-For` are captured automatically.

### Response (`201`)

```json
{
  "sessionId": "b9c4d3fe-...",
  "token": "jwt string",
  "expiresIn": 899,
  "expiresAt": "2024-04-20T08:30:00.000Z",
  "visitorId": "f3ede70f-..."
}
```

### Errors

- `400` – invalid input (missing tenantId, invalid body).
- `404` – tenant not found or inactive.
- `500` – service misconfiguration (missing JWT secret) or unexpected error.

---

## `PATCH /v1/sessions/{sessionId}`

Update an existing session with additional identifiers or cookie data.

### Path Parameters

- `sessionId` – the session identifier to update.

### Request Body

```json
{
  "contactId": "optional string",
  "cookies": {
    "analytics_id": "abc123"
  }
}
```

### Response (`200`)

```json
{
  "sessionId": "b9c4d3fe-...",
  "updated": {
    "contactId": "user-123",
    "context": {
      "analytics_id": "abc123"
    },
    "updatedAt": "2024-04-20T08:45:12.000Z"
  }
}
```

### Errors

- `400` – no fields supplied or invalid payload.
- `404` – session not found.
- `500` – unexpected error.

---

## `GET /health`

Simple status endpoint returning `{ "status": "ok" }`. Useful for orchestrators and monitoring.

---

## `GET /.well-known/jwks.json`

Returns the JSON Web Key Set (JWKS) for verifying RS256 tokens issued by the service.

### Response

```json
{
  "keys": [
    {
      "kid": "7a2c4a4f-...",
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```
