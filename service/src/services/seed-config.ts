// Parse + validate a seed config (RQ-0004, ADR-0018/0019/0020): a gitignored file listing the
// deployment's APPLICATIONS — each with its role catalogue, default audience, and credentials (OAuth
// clients) — plus local users and their per-application assignments. One deployment = one realm, so
// there is no tenant layer; the application is the product-level unit (ADR-0020). Pure (no I/O) so it is
// unit-testable; the loader script (`scripts/seed.ts`) handles YAML reading and the Mongo upserts.

const GRANTS_NEEDING_AUDIENCE = new Set(['password', 'authorization_code']);

export interface SeedAppRole {
  key: string;
  name?: string;
  description?: string;
}

/** A credential (OAuth client) under an application (ADR-0020). */
export interface SeedCredential {
  id: string;
  name?: string;
  grantTypes: string[];
  audience?: string;   // optional per-credential audience OVERRIDE (else inherits the application's)
  redirectUris?: string[];
  scopes?: string[];
  isConfidential?: boolean;
  secret?: string;
  // A client-credentials machine principal (US-0086): the `sub` its token carries and any extra
  // additive claims the resource server matches on. Both optional.
  subject?: string;
  claims?: Record<string, unknown>;
}

export interface SeedApplication {
  id: string;
  name: string;
  audience?: string;          // default token `aud` for this application's credentials
  roles?: SeedAppRole[];      // the application's role catalogue
  credentials?: SeedCredential[];
}

/** A seeded entitlement (ADR-0019/0020): the application the user is assigned to, with app-scoped roles. */
export interface SeedAssignment {
  application: string;
  roles?: string[];
}

export interface SeedUser {
  email: string;
  password: string;
  status?: 'active' | 'locked' | 'disabled';
  assignments?: SeedAssignment[];
}

export interface SeedConfig {
  applications: SeedApplication[];
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

function parseRoleCatalogue(raw: unknown, where: string): SeedAppRole[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new SeedConfigError(`${where} roles must be an array of { key, name?, description? }`);
  return raw.map((r, ri) => {
    if (!isObject(r) || typeof r.key !== 'string' || !r.key.trim()) throw new SeedConfigError(`${where} roles[${ri}] needs a non-empty key`);
    return { key: r.key.trim(), name: typeof r.name === 'string' ? r.name : undefined, description: typeof r.description === 'string' ? r.description : undefined };
  });
}

function parseCredential(c: unknown, where: string, appAudience: string | undefined, env: Record<string, string | undefined>): SeedCredential {
  if (!isObject(c) || typeof c.id !== 'string' || !c.id) throw new SeedConfigError(`${where}.id is required`);
  if (!Array.isArray(c.grantTypes) || c.grantTypes.length === 0) throw new SeedConfigError(`${where} (${c.id}) needs grantTypes`);
  const cg = c.grantTypes as string[];
  const audience = typeof c.audience === 'string' ? c.audience : undefined;
  if (cg.some((g) => GRANTS_NEEDING_AUDIENCE.has(g)) && !(audience ?? appAudience)) {
    throw new SeedConfigError(`${where} (${c.id}) needs an audience (on the credential or the application) for the ${cg.join('/')} grant(s)`);
  }
  if (c.claims !== undefined && !isObject(c.claims)) {
    throw new SeedConfigError(`${where} (${c.id}) claims must be an object of additive token claims`);
  }
  return {
    id: c.id,
    name: typeof c.name === 'string' ? c.name : c.id,
    grantTypes: cg,
    audience,
    redirectUris: Array.isArray(c.redirectUris) ? (c.redirectUris as string[]) : [],
    scopes: Array.isArray(c.scopes) ? (c.scopes as string[]) : [],
    isConfidential: typeof c.isConfidential === 'boolean' ? c.isConfidential : false,
    secret: typeof c.secret === 'string' ? interpolate(c.secret, env) : undefined,
    subject: typeof c.subject === 'string' ? c.subject : undefined,
    claims: isObject(c.claims) ? (c.claims as Record<string, unknown>) : undefined
  };
}

/**
 * Validate raw (already YAML/JSON-parsed) seed data into a typed `SeedConfig`, resolving `${ENV}`
 * references in credential secrets and user passwords. Accepts `{ applications: [...], users: [...] }`
 * (ADR-0020). Throws `SeedConfigError` with a precise message on any structural problem.
 */
export function parseSeedConfig(raw: unknown, env: Record<string, string | undefined> = {}): SeedConfig {
  if (!isObject(raw)) {
    throw new SeedConfigError('Seed config must be an object with `applications` and/or `users`');
  }
  if (raw.applications !== undefined && !Array.isArray(raw.applications)) {
    throw new SeedConfigError('Seed config `applications` must be an array');
  }
  if (raw.users !== undefined && !Array.isArray(raw.users)) {
    throw new SeedConfigError('Seed config `users` must be an array');
  }

  const applications: SeedApplication[] = Array.isArray(raw.applications) ? raw.applications.map((a, ai) => {
    const aw = `applications[${ai}]`;
    if (!isObject(a) || typeof a.id !== 'string' || !a.id) throw new SeedConfigError(`${aw}.id is required`);
    if (typeof a.name !== 'string' || !a.name) throw new SeedConfigError(`${aw} (${a.id}) needs a name`);
    const audience = typeof a.audience === 'string' ? a.audience : undefined;
    const roles = parseRoleCatalogue(a.roles, `${aw} (${a.id})`);
    const credentials: SeedCredential[] = Array.isArray(a.credentials)
      ? a.credentials.map((c, ci) => parseCredential(c, `${aw}.credentials[${ci}]`, audience, env))
      : [];
    return { id: a.id, name: a.name, audience, roles, credentials };
  }) : [];

  // Applications (and their catalogues) must be defined before an assignment can reference them.
  const catalogueByApp = new Map(applications.map((a) => [a.id, new Set((a.roles ?? []).map((r) => r.key))]));

  const users: SeedUser[] = Array.isArray(raw.users) ? raw.users.map((u, ui) => {
    const uw = `users[${ui}]`;
    if (!isObject(u) || typeof u.email !== 'string' || !EMAIL_RE.test(u.email)) throw new SeedConfigError(`${uw} needs a valid email`);
    if (typeof u.password !== 'string' || !u.password) throw new SeedConfigError(`${uw} (${u.email}) needs a password`);
    const password = interpolate(u.password, env);
    if (!password) throw new SeedConfigError(`${uw} (${u.email}) resolved to an empty password`);
    let assignments: SeedAssignment[] = [];
    if (u.assignments !== undefined) {
      if (!Array.isArray(u.assignments)) throw new SeedConfigError(`${uw} (${u.email}) assignments must be an array of { application, roles? }`);
      assignments = u.assignments.map((a, ai) => {
        if (!isObject(a) || typeof a.application !== 'string' || !a.application) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] needs an application`);
        const catalogue = catalogueByApp.get(a.application);
        if (!catalogue) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] references unknown application "${a.application}"`);
        const roles = Array.isArray(a.roles) ? (a.roles as unknown[]).map(String) : [];
        const stray = roles.find((r) => !catalogue.has(r));
        if (stray) throw new SeedConfigError(`${uw} (${u.email}) assignments[${ai}] role "${stray}" is not in application ${a.application}'s roles catalogue`);
        return { application: a.application, roles };
      });
    }
    return { email: u.email.trim().toLowerCase(), password, status: (u.status as SeedUser['status']) ?? 'active', assignments };
  }) : [];

  return { applications, users };
}
