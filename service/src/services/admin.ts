import { randomUUID, randomBytes } from 'crypto';
import type { ClientSession, Connection } from 'mongoose';
import { hashSecret } from '../utils/hash.js';
import { rotateSigningKey, listPublicKeys } from '../utils/key-store.js';
import { generateInviteCode, inviteCodeDigest, deriveInviteStatus } from './invites.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { Logger } from '../utils/logger.js';
import type { AppRole } from '../models/index.js';
import {
  ActRefused,
  clientPrincipalKind,
  createRecorder,
  ensureClientPrincipal,
  ensureUserPrincipal,
  isBodyToken,
  mintPrincipalId,
  realmOf,
  setPrincipalStatus,
  withRecordTransaction,
  type Act,
  type ActContext,
  type RecordConfig,
  type Recorder
} from '../record/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** A management failure with an HTTP status + machine code (mapped by the route / MCP adapter). */
export class AdminServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface AdminServiceDependencies {
  getMasterConnection: () => Promise<Connection>;
  makeModels: (connection: Connection) => ModelsBucket;
  now?: () => Date;
  logger?: Logger;
  /**
   * maestro's record (ADR-0022). With it wired, every act that registers, suspends, reinstates a
   * principal or changes a seat is emitted to the spine in the same transaction — and needs the act
   * context (who is acting) the route or MCP tool resolved at the edge. The container always wires it;
   * it is optional only so a unit test can exercise an operation without the registry.
   */
  record?: RecordConfig;
}

/** An Application (ADR-0020) — a product: owns its name, default audience, role catalogue, and the
 *  protected resources it exposes. */
export interface CreateApplicationInput {
  id?: string;             // stable application id; omit to generate a UUID
  name: string;
  audience?: string;       // default token `aud` for tokens minted through this app's credentials
  roles?: AppRole[];       // the application's role catalogue
  /** Protected resources this app owns — the RFC 8707 `resource` values its credentials may bind a
   *  token to (ADR-0009 Phase 2), e.g. its MCP endpoint URL. */
  resources?: string[];
}

/** A credential under an application (ADR-0020) — an OAuth client (web / machine-runtime / CI). */
export interface CreateClientInput {
  applicationId: string;   // REQUIRED: the application this credential belongs to (ADR-0020)
  /** Optional stable client id (becomes the OAuth `client_id` / Mongo `_id`). Omit to generate a UUID. */
  id?: string;
  name: string;
  grantTypes: string[];
  scopes?: string[];
  redirectUris?: string[];
  audience?: string;       // optional per-credential audience OVERRIDE (else inherits the application's)
  subject?: string;
  isConfidential?: boolean;
  /**
   * Additive token claims (US-0086) merged into this credential's `client_credentials` token — e.g. a
   * product_runtime credential's `{ role: 'product_runtime', email: 'runtime@…' }`. Registered claims
   * (`iss`/`aud`/`exp`/`sub`) are always set by the signer and cannot be overridden.
   */
  claims?: Record<string, unknown>;
}

export interface CreateUserInput {
  email: string;
  password: string;
}

export interface CreateInviteInput {
  applicationId: string;   // the application this invite entitles the redeemer to (ADR-0020, required)
  email?: string;          // optional binding — redemption then requires this address and vouches it
  roles?: string[];        // app-scoped roles granted on redemption; validated against the app's catalogue
  maxUses?: number;        // default 1; >1 for cohort codes
  expiresInHours?: number; // default 7 days
  note?: string;
  createdBy?: string;      // acting principal, threaded from the route/MCP layer for the audit trail
}

export interface AssignUserInput {
  email: string;           // the user to entitle
  applicationId: string;   // the application
  roles?: string[];        // app-scoped roles (subset of the application's catalogue)
  createdBy?: string;
}

const INVITE_DEFAULT_TTL_HOURS = 24 * 7;

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The roles a machine credential declares in its `claims.roles` — its seats on maestro's record. */
function declaredRoles(claims?: Record<string, unknown>): string[] {
  const roles = claims?.roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === 'string' && r.length > 0);
  if (typeof roles === 'string') return roles.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Validate + normalize an application role catalogue (ADR-0019): each entry needs a non-empty `key`. */
function normalizeRoleCatalogue(roles?: AppRole[]): AppRole[] {
  if (roles === undefined) return [];
  if (!Array.isArray(roles)) throw new AdminServiceError('roles must be an array of { key, name?, description? }', 400, 'invalid_input');
  const seen = new Set<string>();
  return roles.map((r) => {
    if (!r || typeof r.key !== 'string' || !r.key.trim()) throw new AdminServiceError('each role needs a non-empty key', 400, 'invalid_input');
    const key = r.key.trim();
    // A role key is a SEAT on maestro's record (ADR-0022) and a body token there: an identifier, never
    // prose. Refused here so a catalogue never holds a role whose grant could not be recorded.
    if (!isBodyToken(key)) throw new AdminServiceError(`role key "${key}" must be an identifier (letters, digits, . _ : @ / + = # -), not free text`, 400, 'invalid_input');
    if (seen.has(key)) throw new AdminServiceError(`duplicate role key "${key}"`, 400, 'invalid_input');
    seen.add(key);
    return { key, name: typeof r.name === 'string' ? r.name : undefined, description: typeof r.description === 'string' ? r.description : undefined };
  });
}

/**
 * Validate + normalize an application's protected-resource registry (ADR-0009 Phase 2). A resource
 * indicator is matched as an exact string at token time, so anything that is not an absolute,
 * fragment-free URI could never match what a client sends — refuse it here rather than store a resource
 * that silently never validates.
 */
function normalizeResources(resources?: string[]): string[] {
  if (resources === undefined) return [];
  if (!Array.isArray(resources)) throw new AdminServiceError('resources must be an array of absolute resource URIs', 400, 'invalid_input');
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const r of resources) {
    if (typeof r !== 'string' || !r.trim()) throw new AdminServiceError('each resource must be a non-empty string', 400, 'invalid_input');
    const value = r.trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AdminServiceError(`resource "${value}" must be an absolute URI`, 400, 'invalid_input');
    }
    if (parsed.hash) throw new AdminServiceError(`resource "${value}" must not carry a fragment`, 400, 'invalid_input');
    if (seen.has(value)) throw new AdminServiceError(`duplicate resource "${value}"`, 400, 'invalid_input');
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** Assert every requested role exists in the application's catalogue (ADR-0019/0020). */
function assertRolesInCatalogue(roles: string[], catalogue: AppRole[], applicationId: string): void {
  const keys = new Set(catalogue.map((r) => r.key));
  const stray = roles.find((r) => !keys.has(r));
  if (stray) throw new AdminServiceError(`Role "${stray}" is not in application ${applicationId}'s role catalogue`, 400, 'invalid_role');
}

export function createAdminService(deps: AdminServiceDependencies) {
  const nowFn = deps.now ?? (() => new Date());
  const models = async (): Promise<ModelsBucket> => deps.makeModels(await deps.getMasterConnection());

  // --- maestro's record (ADR-0022) ---

  /** The recorder for this act, or null when the record is not wired. With it wired, an act without a
   *  known actor is refused: there is nobody to attribute it to, so it is not performed. */
  function recorderFor(m: ModelsBucket, ctx: ActContext | undefined): Recorder | null {
    if (!deps.record) return null;
    if (!ctx) throw new ActRefused('This act has no acting principal and cannot be recorded; it is not performed.', 403, 'unattributed_act');
    return createRecorder({ models: m, config: deps.record, actor: ctx.actor, correlation_id: ctx.correlation_id, logger: deps.logger, now: () => nowFn().toISOString() });
  }

  /** Run the act's writes and its emit as one unit where the database allows it. */
  async function transact<T>(fn: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
    if (!deps.record) return fn(undefined);
    return withRecordTransaction(await deps.getMasterConnection(), fn, deps.logger);
  }

  const realm = () => realmOf(deps.record?.workspaceId ?? 'ws-identity-dev');

  /** One `SeatOccupancyChanged` per role that changed hands, for a human's assignment. */
  function seatChanges(principal: string, applicationId: string, before: readonly string[], after: readonly string[]): Act[] {
    const was = new Set(before);
    const is = new Set(after);
    const acts: Act[] = [];
    for (const seat of after) if (!was.has(seat)) acts.push({ type: 'SeatOccupancyChanged', subject: principal, body: { seat, application: applicationId, change: 'granted', oversight_level: 'O0' } });
    for (const seat of before) if (!is.has(seat)) acts.push({ type: 'SeatOccupancyChanged', subject: principal, body: { seat, application: applicationId, change: 'revoked', oversight_level: 'O0' } });
    return acts;
  }

  /** The roles an assignment actually confers: none while it is suspended. */
  const effectiveRoles = (a: { roles?: string[]; status?: string } | null | undefined): string[] =>
    a && a.status !== 'suspended' ? (a.roles ?? []) : [];

  /** Revoke every seat a set of assignments confers — what a deletion cascades to. Principals are
   *  backfilled on the way, so a pool that predates the registry still records its revocations. */
  async function revokeAllSeats(m: ModelsBucket, assignments: Array<{ userId: string; applicationId: string; roles?: string[]; status?: string }>, session: ClientSession | undefined): Promise<Act[]> {
    const acts: Act[] = [];
    for (const a of assignments) {
      const roles = effectiveRoles(a);
      if (roles.length === 0) continue;
      const user = await m.User.findById(a.userId, null, { session }).select('_id principalId status').lean().exec() as { _id: string; principalId?: string; status?: string } | null;
      if (!user) continue;
      const principal = await ensureUserPrincipal(m, user, session);
      acts.push(...seatChanges(principal.id, a.applicationId, roles, []));
    }
    return acts;
  }

  // --- Applications (ADR-0020): the product-level registration ---

  async function listApplications() {
    const m = await models();
    return m.Application.find().lean().exec();
  }

  async function getApplication(id: string) {
    const m = await models();
    const app = await m.Application.findById(id).lean().exec();
    if (!app) throw new AdminServiceError('Application not found', 404, 'application_not_found');
    return app;
  }

  /** Create (or upsert with an explicit id) an application. */
  async function createApplication(input: CreateApplicationInput): Promise<{ applicationId: string }> {
    if (!input.name?.trim()) throw new AdminServiceError('name is required', 400, 'invalid_input');
    const roles = normalizeRoleCatalogue(input.roles);
    const resources = normalizeResources(input.resources);
    const m = await models();
    const applicationId = input.id?.trim() || randomUUID();
    // An application id names the application on maestro's record (ADR-0022, `SeatOccupancyChanged`)
    // and must be a body token there; refused here rather than at the first assignment.
    if (!isBodyToken(applicationId)) throw new AdminServiceError(`application id "${applicationId}" must be an identifier (letters, digits, . _ : @ / + = # -), not free text`, 400, 'invalid_input');
    try {
      await m.Application.create({ _id: applicationId, name: input.name, audience: input.audience, roles, resources });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AdminServiceError(`Application '${applicationId}' already exists`, 409, 'application_exists');
      throw err;
    }
    deps.logger?.info?.({ applicationId }, 'admin created application');
    return { applicationId };
  }

  /** Delete an application. Refuses while it still has credentials (delete or move those first). Every
   *  seat its assignments conferred is revoked on the record (ADR-0022). */
  async function deleteApplication(applicationId: string, ctx?: ActContext): Promise<{ applicationId: string; deleted: true }> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const credentials = await m.OAuthClient.countDocuments({ applicationId }).exec();
    if (credentials > 0) throw new AdminServiceError(`Application still has ${credentials} credential(s); delete them first`, 409, 'application_has_credentials');
    const exists = await m.Application.findById(applicationId).select('_id').lean().exec();
    if (!exists) throw new AdminServiceError('Application not found', 404, 'application_not_found');
    await transact(async (session) => {
      const assignments = await m.Assignment.find({ applicationId }, null, { session }).lean().exec() as Array<{ userId: string; applicationId: string; roles?: string[]; status?: string }>;
      const acts = recorder ? await revokeAllSeats(m, assignments, session) : [];
      const deleted = await m.Application.findByIdAndDelete(applicationId, { session }).lean().exec();
      if (!deleted) throw new AdminServiceError('Application not found', 404, 'application_not_found');
      await m.Assignment.deleteMany({ applicationId }, { session }).exec();
      if (recorder) await recorder.emit(session, acts);
    });
    deps.logger?.info?.({ applicationId }, 'admin deleted application');
    return { applicationId, deleted: true };
  }

  async function getApplicationRoles(applicationId: string): Promise<AppRole[]> {
    const app = await getApplication(applicationId);
    return (app as { roles?: AppRole[] }).roles ?? [];
  }

  /** Replace an application's role catalogue. Roles already granted to users that are no longer in the
   *  catalogue are NOT retroactively pruned — surface that in the console and re-assign as needed. */
  async function setApplicationRoles(applicationId: string, roles: AppRole[]): Promise<AppRole[]> {
    const catalogue = normalizeRoleCatalogue(roles);
    const m = await models();
    const updated = await m.Application.findByIdAndUpdate(
      applicationId,
      { $set: { roles: catalogue, updatedAt: nowFn() } },
      { new: true }
    ).select('roles').lean().exec();
    if (!updated) throw new AdminServiceError('Application not found', 404, 'application_not_found');
    deps.logger?.info?.({ applicationId, roles: catalogue.length }, 'admin set application role catalogue');
    return (updated as { roles?: AppRole[] }).roles ?? [];
  }

  async function getApplicationResources(applicationId: string): Promise<string[]> {
    const app = await getApplication(applicationId);
    return (app as { resources?: string[] }).resources ?? [];
  }

  /** Replace an application's protected-resource registry (ADR-0009 Phase 2). Tokens already bound to a
   *  resource dropped here keep their `aud` until they expire — the registry gates *issuance*, and a
   *  refresh re-mints against the same resource, so revoke the session to cut an in-flight chain off. */
  async function setApplicationResources(applicationId: string, resources: string[]): Promise<string[]> {
    const registry = normalizeResources(resources);
    const m = await models();
    const updated = await m.Application.findByIdAndUpdate(
      applicationId,
      { $set: { resources: registry, updatedAt: nowFn() } },
      { new: true }
    ).select('resources').lean().exec();
    if (!updated) throw new AdminServiceError('Application not found', 404, 'application_not_found');
    deps.logger?.info?.({ applicationId, resources: registry.length }, 'admin set application resource registry');
    return (updated as { resources?: string[] }).resources ?? [];
  }

  // --- Credentials (OAuth clients under an application) ---

  /** List credentials — all, or (with applicationId) just one application's. Never exposes secretHash. */
  async function listClients(applicationId?: string) {
    const m = await models();
    const filter = applicationId ? { applicationId } : {};
    return m.OAuthClient.find(filter).select('-secretHash').lean().exec();
  }

  /** Register a credential under an application. Returns the generated secret ONCE (only its hash stored).
   *  A `client_credentials` credential is a machine PRINCIPAL — an agent or a workload — and is registered
   *  on maestro's record (ADR-0022); the roles its `claims.roles` declare are seats granted to it. */
  async function createClient(input: CreateClientInput, ctx?: ActContext): Promise<{ clientId: string; secret: string; principalId?: string }> {
    if (!input.applicationId?.trim()) throw new AdminServiceError('applicationId is required', 400, 'invalid_input');
    if (!input.name?.trim()) throw new AdminServiceError('name is required', 400, 'invalid_input');
    if (!Array.isArray(input.grantTypes) || input.grantTypes.length === 0) {
      throw new AdminServiceError('grantTypes must be a non-empty array', 400, 'invalid_input');
    }
    if (input.claims !== undefined && (typeof input.claims !== 'object' || input.claims === null || Array.isArray(input.claims))) {
      throw new AdminServiceError('claims must be an object', 400, 'invalid_input');
    }
    const m = await models();
    const application = await m.Application.findById(input.applicationId).lean().exec();
    if (!application) throw new AdminServiceError('Application not found', 404, 'application_not_found');

    const clientId = input.id?.trim() || randomUUID();
    const secret = newSecret();
    const recorder = recorderFor(m, ctx);
    const kind = clientPrincipalKind({ grantTypes: input.grantTypes, claims: input.claims });
    const principalId = recorder && kind ? mintPrincipalId(kind) : undefined;
    const client = {
      _id: clientId,
      applicationId: input.applicationId,
      name: input.name,
      secretHash: hashSecret(secret),
      grantTypes: input.grantTypes,
      scopes: input.scopes ?? [],
      redirectUris: input.redirectUris ?? [],
      audience: input.audience,
      subject: input.subject,
      isConfidential: input.isConfidential ?? true,
      claims: input.claims,
      ...(principalId ? { principalId } : {})
    };
    try {
      if (recorder && principalId && kind) {
        const now = nowFn();
        const acts: Act[] = [{ type: 'PrincipalRegistered', subject: principalId, body: { kind, source: 'client_credentials', realm: realm() } }];
        for (const seat of declaredRoles(input.claims)) {
          acts.push({ type: 'SeatOccupancyChanged', subject: principalId, body: { seat, application: input.applicationId, change: 'granted', oversight_level: 'O1' } });
        }
        await transact(async (session) => {
          await m.OAuthClient.create([client], { session });
          await m.Principal.create([{ _id: principalId, kind, status: 'active', subjectType: 'client', subjectId: clientId, createdAt: now, updatedAt: now }], { session });
          await recorder.emit(session, acts);
        });
      } else {
        await m.OAuthClient.create(client);
      }
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AdminServiceError(`Client '${clientId}' already exists`, 409, 'client_exists');
      }
      throw err;
    }
    deps.logger?.info?.({ clientId, applicationId: input.applicationId, principalId }, 'admin created credential');
    return { clientId, secret, ...(principalId ? { principalId } : {}) };
  }

  /** Rotate a credential secret. Returns the new secret ONCE. */
  async function rotateClientSecret(clientId: string): Promise<{ clientId: string; secret: string }> {
    const m = await models();
    const secret = newSecret();
    const updated = await m.OAuthClient.findByIdAndUpdate(
      clientId,
      { $set: { secretHash: hashSecret(secret), updatedAt: nowFn() } },
      { new: true }
    ).lean().exec();
    if (!updated) throw new AdminServiceError('Client not found', 404, 'client_not_found');
    deps.logger?.info?.({ clientId }, 'admin rotated client secret');
    return { clientId, secret };
  }

  /** Delete a credential by id. 404 if it does not exist. A machine principal is retired on the record
   *  (ADR-0022): suspended for deletion, its declared seats revoked; the registry row stays. */
  async function deleteClient(clientId: string, ctx?: ActContext): Promise<{ clientId: string; deleted: true }> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const client = await m.OAuthClient.findById(clientId).lean().exec() as { _id: string; applicationId?: string; principalId?: string; grantTypes?: string[]; claims?: Record<string, unknown> } | null;
    if (!client) throw new AdminServiceError('Client not found', 404, 'client_not_found');
    await transact(async (session) => {
      const acts: Act[] = [];
      if (recorder) {
        const principal = await ensureClientPrincipal(m, client, session);
        if (principal) {
          for (const seat of declaredRoles(client.claims)) {
            acts.push({ type: 'SeatOccupancyChanged', subject: principal.id, body: { seat, application: client.applicationId ?? 'unknown', change: 'revoked', oversight_level: 'O1' } });
          }
          acts.push({ type: 'PrincipalSuspended', subject: principal.id, body: { reason: 'deleted' } });
          await setPrincipalStatus(m, principal.id, 'retired', session);
        }
      }
      const deleted = await m.OAuthClient.findByIdAndDelete(clientId, { session }).lean().exec();
      if (!deleted) throw new AdminServiceError('Client not found', 404, 'client_not_found');
      if (recorder) await recorder.emit(session, acts);
    });
    deps.logger?.info?.({ clientId }, 'admin deleted credential');
    return { clientId, deleted: true };
  }

  // --- Users (local-credential IdP) ---

  /** List the deployment's local-credential users. Never exposes passwordHash. */
  async function listUsers() {
    const m = await models();
    return m.User.find().select('-passwordHash').lean().exec();
  }

  /** Create a local-credential user. The person is registered as a HUMAN principal on maestro's record
   *  (ADR-0022), by the operator acting. Roles are per-application (ADR-0019/0020): a new user has no
   *  access until assigned to an application — `assignUser`, or an invite that carries the app + roles. */
  async function createUser(input: CreateUserInput, ctx?: ActContext): Promise<{ id: string; email: string; principalId?: string }> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new AdminServiceError('A valid email is required', 400, 'invalid_email');
    if (!input.password || input.password.length < 1) throw new AdminServiceError('password is required', 400, 'invalid_input');
    const m = await models();
    const recorder = recorderFor(m, ctx);

    const existing = await m.User.findOne({ email }).lean().exec();
    if (existing) throw new AdminServiceError('An account with this email already exists', 409, 'email_taken');

    const id = randomUUID();
    const now = nowFn();
    const principalId = recorder ? mintPrincipalId('human') : undefined;
    const user = {
      _id: id,
      email,
      passwordHash: hashSecret(input.password),
      status: 'active' as const,
      emailVerified: false,
      passwordUpdatedAt: now,
      ...(principalId ? { principalId } : {})
    };
    if (recorder && principalId) {
      await transact(async (session) => {
        await m.User.create([user], { session });
        await m.Principal.create([{ _id: principalId, kind: 'human', status: 'active', subjectType: 'user', subjectId: id, createdAt: now, updatedAt: now }], { session });
        await recorder.emit(session, [{ type: 'PrincipalRegistered', subject: principalId, body: { kind: 'human', source: 'local', realm: realm() } }]);
      });
    } else {
      await m.User.create(user);
    }
    deps.logger?.info?.({ userId: id, principalId }, 'admin created user');
    return { id, email, ...(principalId ? { principalId } : {}) };
  }

  async function resetUserPassword(email: string, password: string): Promise<void> {
    if (!password) throw new AdminServiceError('password is required', 400, 'invalid_input');
    const m = await models();
    const result = await m.User.updateOne(
      { email: email.trim().toLowerCase() },
      { $set: { passwordHash: hashSecret(password), passwordUpdatedAt: nowFn(), failedAttempts: 0, lockedUntil: null, updatedAt: nowFn() } }
    ).exec();
    if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
    deps.logger?.info?.({ email }, 'admin reset user password');
  }

  /** Disable or re-enable a user. On the record (ADR-0022) that is `PrincipalSuspended` / `PrincipalReinstated`
   *  — emitted only when the status actually changes, so a repeated call records nothing twice. */
  async function setUserStatus(email: string, status: 'active' | 'disabled', ctx?: ActContext): Promise<void> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const normalized = email.trim().toLowerCase();
    const user = await m.User.findOne({ email: normalized }).select('_id status principalId').lean().exec() as { _id: string; status?: string; principalId?: string } | null;
    if (!user) throw new AdminServiceError('User not found', 404, 'user_not_found');
    await transact(async (session) => {
      const result = await m.User.updateOne({ email: normalized }, { $set: { status, updatedAt: nowFn() } }, { session }).exec();
      if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
      if (!recorder) return;
      const principal = await ensureUserPrincipal(m, user, session);
      const acts: Act[] = [];
      if (status === 'disabled' && user.status !== 'disabled') acts.push({ type: 'PrincipalSuspended', subject: principal.id, body: { reason: 'disabled' } });
      if (status === 'active' && user.status !== 'active') acts.push({ type: 'PrincipalReinstated', subject: principal.id, body: { reason: user.status === 'locked' ? 'unlocked' : 'enabled' } });
      if (acts.length === 0) return;
      await setPrincipalStatus(m, principal.id, status === 'disabled' ? 'suspended' : 'active', session);
      await recorder.emit(session, acts);
    });
    deps.logger?.info?.({ email, status }, 'admin set user status');
  }

  /** Clear a brute-force lockout (and reactivate if locked). A user that was disabled or locked is
   *  reinstated on the record (ADR-0022); clearing counters on an active user records nothing. */
  async function unlockUser(email: string, ctx?: ActContext): Promise<void> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const normalized = email.trim().toLowerCase();
    const user = await m.User.findOne({ email: normalized }).select('_id status principalId').lean().exec() as { _id: string; status?: string; principalId?: string } | null;
    if (!user) throw new AdminServiceError('User not found', 404, 'user_not_found');
    await transact(async (session) => {
      const result = await m.User.updateOne(
        { email: normalized },
        { $set: { failedAttempts: 0, lockedUntil: null, status: 'active', updatedAt: nowFn() } },
        { session }
      ).exec();
      if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
      if (!recorder || user.status === 'active' || user.status === undefined) return;
      const principal = await ensureUserPrincipal(m, user, session);
      await setPrincipalStatus(m, principal.id, 'active', session);
      await recorder.emit(session, [{ type: 'PrincipalReinstated', subject: principal.id, body: { reason: 'unlocked' } }]);
    });
    deps.logger?.info?.({ email }, 'admin unlocked user');
  }

  /** Link a federated identity onto an existing user (RQ-0011 US-5). */
  async function linkUserIdentity(
    email: string,
    identity: { provider: 'google'; subject: string; identityEmail?: string; emailVerified?: boolean }
  ): Promise<{ email: string; provider: string; subject: string; linked: true }> {
    if (identity?.provider !== 'google') throw new AdminServiceError("provider must be 'google'", 400, 'invalid_input');
    if (!identity.subject?.trim()) throw new AdminServiceError('subject is required', 400, 'invalid_input');
    const m = await models();
    const normalized = email.trim().toLowerCase();
    const user = await m.User.findOne({ email: normalized }).lean().exec() as { _id: string; identities?: { provider: string; subject: string }[] } | null;
    if (!user) throw new AdminServiceError('User not found', 404, 'user_not_found');

    const owner = await m.User.findOne({ 'identities.provider': 'google', 'identities.subject': identity.subject }).lean().exec() as { _id?: string } | null;
    if (owner && owner._id !== user._id) {
      throw new AdminServiceError('Identity is already linked to another user', 409, 'identity_linked');
    }

    const already = (user.identities ?? []).some((i) => i.provider === 'google' && i.subject === identity.subject);
    if (!already) {
      await m.User.updateOne(
        { email: normalized },
        {
          $push: { identities: {
            provider: 'google',
            subject: identity.subject,
            email: identity.identityEmail?.trim().toLowerCase(),
            emailVerified: identity.emailVerified ?? false,
            linkedAt: nowFn()
          } },
          $set: { updatedAt: nowFn() }
        }
      ).exec();
    }
    deps.logger?.info?.({ email: normalized, subject: identity.subject }, 'admin linked user identity');
    return { email: normalized, provider: 'google', subject: identity.subject, linked: true };
  }

  /** Remove a linked federated identity from a user (RQ-0011 US-5). */
  async function unlinkUserIdentity(
    email: string,
    identity: { provider: 'google'; subject: string }
  ): Promise<{ email: string; provider: string; subject: string; unlinked: true }> {
    if (identity?.provider !== 'google') throw new AdminServiceError("provider must be 'google'", 400, 'invalid_input');
    if (!identity.subject?.trim()) throw new AdminServiceError('subject is required', 400, 'invalid_input');
    const m = await models();
    const normalized = email.trim().toLowerCase();
    const result = await m.User.updateOne(
      { email: normalized },
      { $pull: { identities: { provider: 'google', subject: identity.subject } }, $set: { updatedAt: nowFn() } }
    ).exec();
    if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
    deps.logger?.info?.({ email: normalized, subject: identity.subject }, 'admin unlinked user identity');
    return { email: normalized, provider: 'google', subject: identity.subject, unlinked: true };
  }

  /** Delete a local-credential user (and their assignments). 404 if it does not exist. On the record
   *  (ADR-0022) every seat they held is revoked and the principal is suspended for deletion; the registry
   *  row is retired, never removed, so the archive can still say a human acted. */
  async function deleteUser(email: string, ctx?: ActContext): Promise<{ email: string; deleted: true }> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const normalized = email.trim().toLowerCase();
    const user = await m.User.findOne({ email: normalized }).select('_id status principalId').lean().exec() as { _id: string; status?: string; principalId?: string } | null;
    if (!user) throw new AdminServiceError('User not found', 404, 'user_not_found');
    await transact(async (session) => {
      const acts: Act[] = [];
      if (recorder) {
        const principal = await ensureUserPrincipal(m, user, session);
        const assignments = await m.Assignment.find({ userId: user._id }, null, { session }).lean().exec() as Array<{ applicationId: string; roles?: string[]; status?: string }>;
        for (const a of assignments) acts.push(...seatChanges(principal.id, a.applicationId, effectiveRoles(a), []));
        acts.push({ type: 'PrincipalSuspended', subject: principal.id, body: { reason: 'deleted' } });
        await setPrincipalStatus(m, principal.id, 'retired', session);
      }
      await m.User.deleteOne({ _id: user._id }, { session }).exec();
      await m.Assignment.deleteMany({ userId: user._id }, { session }).exec();
      if (recorder) await recorder.emit(session, acts);
    });
    deps.logger?.info?.({ email: normalized }, 'admin deleted user');
    return { email: normalized, deleted: true };
  }

  // --- Assignments (ADR-0019/0020): a user's entitlement + app-scoped roles for an application ---

  async function resolveUserByEmail(m: ModelsBucket, email: string): Promise<{ _id: string; principalId?: string; status?: string }> {
    const user = await m.User.findOne({ email: email.trim().toLowerCase() }).select('_id principalId status').lean().exec() as { _id: string; principalId?: string; status?: string } | null;
    if (!user) throw new AdminServiceError('User not found', 404, 'user_not_found');
    return user;
  }

  async function requireApplicationDoc(m: ModelsBucket, applicationId: string): Promise<{ _id: string; roles?: AppRole[]; name?: string }> {
    const app = await m.Application.findById(applicationId).lean().exec() as { _id: string; roles?: AppRole[]; name?: string } | null;
    if (!app) throw new AdminServiceError('Application not found', 404, 'application_not_found');
    return app;
  }

  /** Assign (or re-assign) a user to an application with app-scoped roles. Idempotent upsert. On the
   *  record (ADR-0022) each role that changes hands is a `SeatOccupancyChanged`: the application's role is
   *  the seat, the assignment its occupancy; an unchanged re-assignment records nothing. */
  async function assignUser(input: AssignUserInput, ctx?: ActContext): Promise<{ email: string; applicationId: string; roles: string[]; status: string }> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!input.applicationId?.trim()) throw new AdminServiceError('applicationId is required', 400, 'invalid_input');
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const user = await resolveUserByEmail(m, email);
    const application = await requireApplicationDoc(m, input.applicationId);
    const roles = input.roles ?? [];
    assertRolesInCatalogue(roles, application.roles ?? [], input.applicationId);

    const now = nowFn();
    const assignment = await transact(async (session) => {
      const before = await m.Assignment.findOne({ userId: user._id, applicationId: input.applicationId }, null, { session }).lean().exec() as { roles?: string[]; status?: string } | null;
      const updated = await m.Assignment.findOneAndUpdate(
        { userId: user._id, applicationId: input.applicationId },
        {
          $set: { roles, status: 'active', updatedAt: now },
          $setOnInsert: { _id: randomUUID(), userId: user._id, applicationId: input.applicationId, createdBy: input.createdBy, createdAt: now }
        },
        { upsert: true, new: true, session }
      ).lean().exec();
      if (recorder) {
        const principal = await ensureUserPrincipal(m, user, session);
        await recorder.emit(session, seatChanges(principal.id, input.applicationId, effectiveRoles(before), roles));
      }
      return updated;
    });
    deps.logger?.info?.({ email, applicationId: input.applicationId, roles }, 'admin assigned user to application');
    return { email, applicationId: input.applicationId, roles: assignment?.roles ?? roles, status: assignment?.status ?? 'active' };
  }

  /** Change an existing assignment's roles and/or status (suspend/reactivate). A suspended assignment
   *  confers no seats, so suspending revokes every role on the record and reactivating grants them back. */
  async function updateAssignment(
    email: string,
    applicationId: string,
    changes: { roles?: string[]; status?: 'active' | 'suspended' },
    ctx?: ActContext
  ): Promise<{ email: string; applicationId: string; roles: string[]; status: string }> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const user = await resolveUserByEmail(m, email);
    const set: Record<string, unknown> = { updatedAt: nowFn() };
    if (changes.roles !== undefined) {
      const application = await requireApplicationDoc(m, applicationId);
      assertRolesInCatalogue(changes.roles, application.roles ?? [], applicationId);
      set.roles = changes.roles;
    }
    if (changes.status !== undefined) {
      if (changes.status !== 'active' && changes.status !== 'suspended') {
        throw new AdminServiceError("status must be 'active' or 'suspended'", 400, 'invalid_input');
      }
      set.status = changes.status;
    }
    const updated = await transact(async (session) => {
      const before = await m.Assignment.findOne({ userId: user._id, applicationId }, null, { session }).lean().exec() as { roles?: string[]; status?: string } | null;
      const after = await m.Assignment.findOneAndUpdate(
        { userId: user._id, applicationId },
        { $set: set },
        { new: true, session }
      ).lean().exec();
      if (!after) throw new AdminServiceError('Assignment not found', 404, 'assignment_not_found');
      if (recorder) {
        const principal = await ensureUserPrincipal(m, user, session);
        await recorder.emit(session, seatChanges(principal.id, applicationId, effectiveRoles(before), effectiveRoles(after)));
      }
      return after;
    });
    deps.logger?.info?.({ email, applicationId }, 'admin updated assignment');
    return { email, applicationId, roles: updated.roles ?? [], status: updated.status };
  }

  /** Revoke a user's entitlement to an application (deletes the assignment); every seat it conferred is
   *  revoked on the record (ADR-0022). */
  async function revokeAssignment(email: string, applicationId: string, ctx?: ActContext): Promise<{ email: string; applicationId: string; revoked: true }> {
    const m = await models();
    const recorder = recorderFor(m, ctx);
    const user = await resolveUserByEmail(m, email);
    await transact(async (session) => {
      const before = await m.Assignment.findOne({ userId: user._id, applicationId }, null, { session }).lean().exec() as { roles?: string[]; status?: string } | null;
      const result = await m.Assignment.deleteOne({ userId: user._id, applicationId }, { session }).exec();
      if (result.deletedCount === 0) throw new AdminServiceError('Assignment not found', 404, 'assignment_not_found');
      if (recorder) {
        const principal = await ensureUserPrincipal(m, user, session);
        await recorder.emit(session, seatChanges(principal.id, applicationId, effectiveRoles(before), []));
      }
    });
    deps.logger?.info?.({ email, applicationId }, 'admin revoked assignment');
    return { email, applicationId, revoked: true };
  }

  /** List the users assigned to an application (its "members"), with their app-scoped roles. */
  async function listApplicationMembers(applicationId: string) {
    const m = await models();
    await requireApplicationDoc(m, applicationId);
    const assignments = await m.Assignment.find({ applicationId }).lean().exec();
    const users = await m.User.find({ _id: { $in: assignments.map((a) => a.userId) } }).select('_id email status').lean().exec();
    const byId = new Map(users.map((u) => [u._id, u as { email: string; status: string }]));
    return assignments.map((a) => ({
      userId: a.userId,
      email: byId.get(a.userId)?.email,
      userStatus: byId.get(a.userId)?.status,
      status: a.status,
      roles: a.roles ?? []
    }));
  }

  /** List the applications a user is assigned to, with their app-scoped roles. */
  async function listUserAssignments(email: string) {
    const m = await models();
    const user = await resolveUserByEmail(m, email);
    const assignments = await m.Assignment.find({ userId: user._id }).lean().exec();
    const apps = await m.Application.find({ _id: { $in: assignments.map((a) => a.applicationId) } }).select('_id name').lean().exec();
    const byId = new Map(apps.map((a) => [a._id, a as { name: string }]));
    return assignments.map((a) => ({
      applicationId: a.applicationId,
      applicationName: byId.get(a.applicationId)?.name,
      status: a.status,
      roles: a.roles ?? []
    }));
  }

  // --- Invites (RQ-0013) ---

  /** Mint a registration invite entitling the redeemer to an application. Returns the code ONCE. */
  async function createInvite(input: CreateInviteInput): Promise<{ inviteId: string; code: string; expiresAt: Date }> {
    if (!input.applicationId?.trim()) throw new AdminServiceError('applicationId is required', 400, 'invalid_input');
    const m = await models();

    const application = await requireApplicationDoc(m, input.applicationId);
    const roles = input.roles ?? [];
    assertRolesInCatalogue(roles, application.roles ?? [], input.applicationId);

    const email = input.email?.trim().toLowerCase();
    if (email !== undefined && !EMAIL_RE.test(email)) {
      throw new AdminServiceError('email must be a valid address', 400, 'invalid_email');
    }
    const maxUses = input.maxUses ?? 1;
    if (!Number.isInteger(maxUses) || maxUses < 1) {
      throw new AdminServiceError('maxUses must be a positive integer', 400, 'invalid_input');
    }
    const ttlHours = input.expiresInHours ?? INVITE_DEFAULT_TTL_HOURS;
    if (!(ttlHours > 0)) throw new AdminServiceError('expiresInHours must be positive', 400, 'invalid_input');

    const now = nowFn();
    const inviteId = randomUUID();
    const code = generateInviteCode();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
    await m.Invite.create({
      _id: inviteId,
      applicationId: input.applicationId,
      codeDigest: inviteCodeDigest(code),
      email,
      roles,
      maxUses,
      usesRemaining: maxUses,
      expiresAt,
      createdBy: input.createdBy,
      note: input.note,
      createdAt: now,
      updatedAt: now
    });
    deps.logger?.info?.({ inviteId, applicationId: input.applicationId, maxUses }, 'admin created invite');
    return { inviteId, code, expiresAt };
  }

  /** List the deployment's invites with derived status. Never exposes the code or its digest. */
  async function listInvites() {
    const m = await models();
    const now = nowFn();
    const invites = await m.Invite.find().sort({ createdAt: -1 }).lean().exec();
    return invites.map((invite) => {
      const { codeDigest: _digest, usesRemaining, ...rest } = invite as typeof invite & { codeDigest?: string };
      return {
        ...rest,
        usedCount: invite.maxUses - invite.usesRemaining,
        status: deriveInviteStatus(invite, now)
      };
    });
  }

  /** Revoke an invite so no further redemptions succeed. Idempotent on an already-revoked invite. */
  async function revokeInvite(inviteId: string): Promise<{ inviteId: string; revoked: true }> {
    const m = await models();
    const updated = await m.Invite.findByIdAndUpdate(
      inviteId,
      { $set: { revokedAt: nowFn(), updatedAt: nowFn() } },
      { new: true }
    ).lean().exec();
    if (!updated) throw new AdminServiceError('Invite not found', 404, 'invite_not_found');
    deps.logger?.info?.({ inviteId }, 'admin revoked invite');
    return { inviteId, revoked: true };
  }

  // --- Signing keys ---

  async function rotateKey() {
    const key = await rotateSigningKey();
    deps.logger?.info?.({ kid: key.kid }, 'admin rotated signing key');
    return { kid: key.kid };
  }

  async function keyStatus() {
    return listPublicKeys();
  }

  // --- Statistics (feeds the console dashboards) ---

  async function getStats() {
    const m = await models();
    const now = nowFn();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      applications, clients, users, lockedUsers, disabledUsers, assignments,
      tokensLastHour, tokensLastDay, activeRefresh, activeKeys
    ] = await Promise.all([
      m.Application.countDocuments({}).exec(),
      m.OAuthClient.countDocuments({}).exec(),
      m.User.countDocuments({}).exec(),
      m.User.countDocuments({ lockedUntil: { $gt: now } }).exec(),
      m.User.countDocuments({ status: 'disabled' }).exec(),
      m.Assignment.countDocuments({ status: 'active' }).exec(),
      m.OAuthToken.countDocuments({ type: 'access', issuedAt: { $gte: hourAgo } }).exec(),
      m.OAuthToken.countDocuments({ type: 'access', issuedAt: { $gte: dayAgo } }).exec(),
      m.OAuthToken.countDocuments({ type: 'refresh', status: 'active' }).exec(),
      m.KeyStore.countDocuments({ status: 'active' }).exec()
    ]);

    return {
      applications: { total: applications },
      clients: { total: clients },
      users: { total: users, locked: lockedUsers, disabled: disabledUsers },
      assignments: { active: assignments },
      tokens: { accessLastHour: tokensLastHour, accessLastDay: tokensLastDay, activeRefresh },
      keys: { active: activeKeys },
      at: now.toISOString()
    };
  }

  return {
    listApplications, getApplication, createApplication, deleteApplication, getApplicationRoles, setApplicationRoles,
    getApplicationResources, setApplicationResources,
    listClients, createClient, rotateClientSecret, deleteClient,
    listUsers, createUser, resetUserPassword, setUserStatus, unlockUser, deleteUser,
    linkUserIdentity, unlinkUserIdentity,
    assignUser, updateAssignment, revokeAssignment, listApplicationMembers, listUserAssignments,
    createInvite, listInvites, revokeInvite,
    rotateKey, keyStatus, getStats
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
