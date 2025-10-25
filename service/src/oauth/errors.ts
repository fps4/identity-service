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
