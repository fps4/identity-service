# Core Auth API

All endpoints are prefixed with `/v1` and serve JSON responses.

## Authentication

The service currently relies on network-level controls (private network, API gateway, etc.). Downstream consumers can optionally send an `Authorization` header; the service will pass it to logging middleware but does not verify it yet.

## Headers

- `Content-Type: application/json`
- `Origin` – used to enforce CORS per tenant.

---

## `POST /v1/tenants/{tenantId}/sessions`

Create a session and issue a JWT.

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
