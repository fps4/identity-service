// Parse + validate a seed config (RQ-0004, ADR-0018): a gitignored file listing the deployment's OAuth
// clients and local users for operator-run, idempotent provisioning. One deployment = one realm, so the
// config is a single flat set of clients + users — there is no tenant layer. Realm-wide settings
// (allowed origins, registration mode, role vocabulary, IdP toggles) are deployment env, not seed data.
// Pure (no I/O) so it is unit-testable; the loader script (`scripts/seed.ts`) handles YAML reading and
// the Mongo upserts.

const GRANTS_NEEDING_AUDIENCE = new Set(['password', 'authorization_code']);

export interface SeedAppRole {
  key: string;
  name?: string;
  description?: string;
}

export interface SeedClient {
  id: string;
  name?: string;
  grantTypes: string[];
  audience?: string;
  redirectUris?: string[];
  scopes?: string[];
  isConfidential?: boolean;
  // The application's role catalogue (ADR-0019): the roles assignments may grant for this client.
  roles?: SeedAppRole[];
  secret?: string;
  // A client-credentials machine principal (US-0086): the `sub` its token carries and any extra
  // additive claims (e.g. `{ role: 'product_runtime', email: 'runtime@…' }`) the resource server
  // matches on. Both optional — an ordinary CI client needs neither.
  subject?: string;
  claims?: Record<string, unknown>;
}

/** A seeded entitlement (ADR-0019): the app the user is assigned to, with app-scoped roles. */
export interface SeedAssignment {
  client: string;
  roles?: string[];
}

export interface SeedUser {
  email: string;
  password: string;
  status?: 'active' | 'locked' | 'disabled';
  assignments?: SeedAssignment[];
}

export interface SeedConfig {
  clients: SeedClient[];
  users: SeedUser[];
}

export class SeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedConfigError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Replace any string that is exactly `${VAR}` with `env[VAR]` (so secrets need not live in the file).
 * Throws if a referenced variable is unset. Non-`${...}` strings pass through unchanged.
 */
function interpolate(value: string, env: Record<string, string | undefined>): string {
  const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
  if (!match) return value;
  const resolved = env[match[1]];
  if (resolved === undefined || resolved === '') {
    throw new SeedConfigError(`Seed config references env var ${match[1]} which is unset`);
  }
  return resolved;
}

/**
 * Validate raw (already YAML/JSON-parsed) seed data into a typed `SeedConfig`, resolving `${ENV}`
 * references in client secrets and user passwords. Throws `SeedConfigError` with a precise message
 * on any structural problem. Accepts a flat `{ clients: [...], users: [...] }` (ADR-0018).
 */
export function parseSeedConfig(raw: unknown, env: Record<string, string | undefined> = {}): SeedConfig {
  if (!isObject(raw)) {
    throw new SeedConfigError('Seed config must be an object with `clients` and/or `users`');
  }
  if (raw.clients !== undefined && !Array.isArray(raw.clients)) {
    throw new SeedConfigError('Seed config `clients` must be an array');
  }
  if (raw.users !== undefined && !Array.isArray(raw.users)) {
    throw new SeedConfigError('Seed config `users` must be an array');
  }

  const clients: SeedClient[] = Array.isArray(raw.clients) ? raw.clients.map((c, ci) => {
    const cw = `clients[${ci}]`;
    if (!isObject(c) || typeof c.id !== 'string' || !c.id) throw new SeedConfigError(`${cw}.id is required`);
    if (!Array.isArray(c.grantTypes) || c.grantTypes.length === 0) throw new SeedConfigError(`${cw} (${c.id}) needs grantTypes`);
    const cg = c.grantTypes as string[];
    if (cg.some((g) => GRANTS_NEEDING_AUDIENCE.has(g)) && !c.audience) {
      throw new SeedConfigError(`${cw} (${c.id}) needs an audience for the ${cg.join('/')} grant(s)`);
    }
    if (c.claims !== undefined && !isObject(c.claims)) {
      throw new SeedConfigError(`${cw} (${c.id}) claims must be an object of additive token claims`);
    }
    let roles: SeedAppRole[] = [];
    if (c.roles !== undefined) {
      if (!Array.isArray(c.roles)) throw new SeedConfigError(`${cw} (${c.id}) roles must be an array of { key, name?, description? }`);
      roles = c.roles.map((r, ri) => {
        if (!isObject(r) || typeof r.key !== 'string' || !r.key.trim()) throw new SeedConfigError(`${cw} (${c.id}) roles[${ri}] needs a non-empty key`);
        return { key: r.key.trim(), name: typeof r.name === 'string' ? r.name : undefined, description: typeof r.description === 'string' ? r.description : undefined };
      });
    }
    return {
      id: c.id,
      name: typeof c.name === 'string' ? c.name : c.id,
      grantTypes: cg,
      audience: typeof c.audience === 'string' ? c.audience : undefined,
      redirectUris: Array.isArray(c.redirectUris) ? (c.redirectUris as string[]) : [],
      scopes: Array.isArray(c.scopes) ? (c.scopes as string[]) : [],
      isConfidential: typeof c.isConfidential === 'boolean' ? c.isConfidential : false,
      roles,
      secret: typeof c.secret === 'string' ? interpolate(c.secret, env) : undefined,
      subject: typeof c.subject === 'string' ? c.subject : undefined,
      claims: isObject(c.claims) ? (c.claims as Record<string, unknown>) : undefined
    };
  }) : [];

  // Role catalogues must be defined before an assignment can reference them.
  const catalogueByClient = new Map(clients.map((c) => [c.id, new Set((c.roles ?? []).map((r) => r.key))]));

  const users: SeedUser[] = Array.isArray(raw.users) ? raw.users.map((u, ui) => {
    const uw = `users[${ui}]`;
    if (!isObject(u) || typeof u.email !== 'string' || !EMAIL_RE.test(u.email)) throw new SeedConfigError(`${uw} needs a valid email`);
    if (typeof u.password !== 'string' || !u.password) throw new SeedConfigError(`${uw} (${u.email}) needs a password`);
    const password = interpolate(u.password, env);
    if (!password) throw new SeedConfigError(`${uw} (${u.email}) resolved to an empty password`);
    let assignments: SeedAssignment[] = [];
    if (u.assignments !== undefined) {
      if (!Array.isArray(u.assignments)) throw new SeedConfigError(`${uw} (${u.email}) assignments must be an array of { client, roles? }`);
      assignments = u.assignments.map((a, ai) => {
        if (!isObject(a) || typeof a.client !== 'string' || !a.client) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] needs a client`);
        const catalogue = catalogueByClient.get(a.client);
        if (!catalogue) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] references unknown client "${a.client}"`);
        const roles = Array.isArray(a.roles) ? (a.roles as unknown[]).map(String) : [];
        const stray = roles.find((r) => !catalogue.has(r));
        if (stray) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] role "${stray}" is not in client ${a.client}'s roles catalogue`);
        return { client: a.client, roles };
      });
    }
    return { email: u.email.trim().toLowerCase(), password, status: (u.status as SeedUser['status']) ?? 'active', assignments };
  }) : [];

  return { clients, users };
}
