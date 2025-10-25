export class CoreAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidInputError extends CoreAuthError {
  constructor(message: string) {
    super(message);
  }
}

export class TenantNotFoundError extends CoreAuthError {
  constructor(public readonly tenantId: string) {
    super(`Tenant ${tenantId} not found`);
  }
}

export class MissingJwtSecretError extends CoreAuthError {
  constructor() {
    super('JWT secret is not configured');
  }
}

export class SessionNotFoundError extends CoreAuthError {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} not found`);
  }
}

export class NoSessionUpdatesProvidedError extends CoreAuthError {
  constructor() {
    super('No updatable fields provided');
  }
}
