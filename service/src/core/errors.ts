export class ComponentAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidInputError extends ComponentAuthError {
  constructor(message: string) {
    super(message);
  }
}

export class TenantNotFoundError extends ComponentAuthError {
  constructor(public readonly tenantId: string) {
    super(`Tenant ${tenantId} not found`);
  }
}

export class MissingJwtSecretError extends ComponentAuthError {
  constructor() {
    super('JWT secret is not configured');
  }
}

export class SessionNotFoundError extends ComponentAuthError {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} not found`);
  }
}

export class NoSessionUpdatesProvidedError extends ComponentAuthError {
  constructor() {
    super('No updatable fields provided');
  }
}
