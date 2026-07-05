export class OAuthError extends Error {
  constructor(message: string, public readonly status: number, public readonly error: string, public readonly description?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidClientError extends OAuthError {
  constructor(description?: string) {
    super('Invalid client', 401, 'invalid_client', description);
  }
}

export class UnauthorizedClientError extends OAuthError {
  constructor(description?: string) {
    super('Unauthorized client', 400, 'unauthorized_client', description);
  }
}

export class InvalidScopeError extends OAuthError {
  constructor(description?: string) {
    super('Invalid scope', 400, 'invalid_scope', description);
  }
}

export class InvalidRequestError extends OAuthError {
  constructor(description?: string) {
    super('Invalid request', 400, 'invalid_request', description);
  }
}

export class RateLimitExceededError extends OAuthError {
  constructor(retryInSec: number) {
    super('Rate limit exceeded', 429, 'slow_down', `Retry after ${retryInSec} seconds`);
  }
}

/** The requested `resource` (RFC 8707 resource indicator) is not a protected resource this
 *  authorization server issues tokens for. RFC 8707 §2 `invalid_target`. */
export class InvalidTargetError extends OAuthError {
  constructor(description?: string) {
    super('Invalid target', 400, 'invalid_target', description);
  }
}

/** A presented grant artefact (authorization code, PKCE verifier, or refresh token) was invalid,
 *  expired, already used, or did not match the request. RFC 6749 §5.2 `invalid_grant`. */
export class InvalidGrantError extends OAuthError {
  constructor(description?: string) {
    super('Invalid grant', 400, 'invalid_grant', description);
  }
}

/** The upstream Google authentication failed, or its id_token failed verification (bad signature,
 *  issuer/audience, expiry, or nonce). The flow is denied and no token is issued (RQ-0001 AC). */
export class AccessDeniedError extends OAuthError {
  constructor(description?: string) {
    super('Access denied', 403, 'access_denied', description);
  }
}
