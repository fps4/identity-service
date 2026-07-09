import { randomUUID, randomBytes } from 'crypto';
import type { Connection } from 'mongoose';
import { CONFIG } from '../config.js';
import { hashSecret } from '../utils/hash.js';
import { rotateSigningKey, listPublicKeys } from '../utils/key-store.js';
import { generateInviteCode, inviteCodeDigest, deriveInviteStatus } from './invites.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { Logger } from '../utils/logger.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
}

export interface CreateClientInput {
  /** Optional stable client id (becomes the OAuth `client_id` / Mongo `_id`). Omit to generate a UUID. */
  id?: string;
  name: string;
  grantTypes: string[];
  scopes?: string[];
  redirectUris?: string[];
  audience?: string;
  subject?: string;
  isConfidential?: boolean;
  /**
   * Additive token claims (US-0086) merged into this client's `client_credentials` token — e.g. a
   * product_runtime credential's `{ role: 'product_runtime', email: 'runtime@…' }`. Registered claims
   * (`iss`/`aud`/`exp`/`sub`) are always set by the signer and cannot be overridden. Lets a
   * product_runtime client be created wholly through the management plane (ADR-0017), not a DB patch.
   */
  claims?: Record<string, unknown>;
}

export interface CreateUserInput {
  email: string;
  password: string;
  roles?: string[];
}

export interface CreateInviteInput {
  email?: string;          // optional binding — redemption then requires this address and vouches it
  roles?: string[];        // stamped on the redeemed user; validated against CONFIG.auth.allowedRoles
  maxUses?: number;        // default 1; >1 for cohort codes
  expiresInHours?: number; // default 7 days
  note?: string;
  createdBy?: string;      // acting principal, threaded from the route/MCP layer for the audit trail
}

const INVITE_DEFAULT_TTL_HOURS = 24 * 7;

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function createAdminService(deps: AdminServiceDependencies) {
  const nowFn = deps.now ?? (() => new Date());
  const models = async (): Promise<ModelsBucket> => deps.makeModels(await deps.getMasterConnection());

  // --- Clients ---

  async function listClients() {
    const m = await models();
    // Never expose secretHash.
    return m.OAuthClient.find().select('-secretHash').lean().exec();
  }

  /** Register a client. Returns the generated secret ONCE (only its hash is stored). */
  async function createClient(input: CreateClientInput): Promise<{ clientId: string; secret: string }> {
    if (!input.name?.trim()) throw new AdminServiceError('name is required', 400, 'invalid_input');
    if (!Array.isArray(input.grantTypes) || input.grantTypes.length === 0) {
      throw new AdminServiceError('grantTypes must be a non-empty array', 400, 'invalid_input');
    }
    if (input.claims !== undefined && (typeof input.claims !== 'object' || input.claims === null || Array.isArray(input.claims))) {
      throw new AdminServiceError('claims must be an object', 400, 'invalid_input');
    }
    const m = await models();

    const clientId = input.id?.trim() || randomUUID();
    const secret = newSecret();
    try {
      await m.OAuthClient.create({
        _id: clientId,
        name: input.name,
        secretHash: hashSecret(secret),
        grantTypes: input.grantTypes,
        scopes: input.scopes ?? [],
        redirectUris: input.redirectUris ?? [],
        audience: input.audience,
        subject: input.subject,
        isConfidential: input.isConfidential ?? true,
        claims: input.claims
      });
    } catch (err) {
      // Duplicate _id when an explicit id is reused — surface a clean conflict rather than a raw Mongo error.
      if ((err as { code?: number }).code === 11000) {
        throw new AdminServiceError(`Client '${clientId}' already exists`, 409, 'client_exists');
      }
      throw err;
    }
    deps.logger?.info?.({ clientId }, 'admin created client');
    return { clientId, secret };
  }

  /** Rotate a client secret. Returns the new secret ONCE. */
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

  /** Delete a client by id. 404 if it does not exist. */
  async function deleteClient(clientId: string): Promise<{ clientId: string; deleted: true }> {
    const m = await models();
    const deleted = await m.OAuthClient.findByIdAndDelete(clientId).lean().exec();
    if (!deleted) throw new AdminServiceError('Client not found', 404, 'client_not_found');
    deps.logger?.info?.({ clientId }, 'admin deleted client');
    return { clientId, deleted: true };
  }

  // --- Users (local-credential IdP) ---

  /** List the deployment's local-credential users. Never exposes passwordHash. */
  async function listUsers() {
    const m = await models();
    return m.User.find().select('-passwordHash').lean().exec();
  }

  async function createUser(input: CreateUserInput): Promise<{ id: string; email: string }> {
    const email = (input.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new AdminServiceError('A valid email is required', 400, 'invalid_email');
    if (!input.password || input.password.length < 1) throw new AdminServiceError('password is required', 400, 'invalid_input');
    const m = await models();

    const existing = await m.User.findOne({ email }).lean().exec();
    if (existing) throw new AdminServiceError('An account with this email already exists', 409, 'email_taken');

    const id = randomUUID();
    await m.User.create({
      _id: id,
      email,
      passwordHash: hashSecret(input.password),
      status: 'active',
      emailVerified: false,
      roles: input.roles ?? [],
      passwordUpdatedAt: nowFn()
    });
    deps.logger?.info?.({ userId: id }, 'admin created user');
    return { id, email };
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

  async function setUserStatus(email: string, status: 'active' | 'disabled'): Promise<void> {
    const m = await models();
    const result = await m.User.updateOne(
      { email: email.trim().toLowerCase() },
      { $set: { status, updatedAt: nowFn() } }
    ).exec();
    if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
    deps.logger?.info?.({ email, status }, 'admin set user status');
  }

  /** Clear a brute-force lockout (and reactivate if locked). */
  async function unlockUser(email: string): Promise<void> {
    const m = await models();
    const result = await m.User.updateOne(
      { email: email.trim().toLowerCase() },
      { $set: { failedAttempts: 0, lockedUntil: null, status: 'active', updatedAt: nowFn() } }
    ).exec();
    if (result.matchedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
    deps.logger?.info?.({ email }, 'admin unlocked user');
  }

  /** Link a federated identity onto an existing user (RQ-0011 US-5) — the operator counterpart to the
   *  automatic link-on-verified-email at login, for the ambiguous cases the system won't merge itself. */
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

    // The identity must not already belong to another user (the unique index also enforces this).
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

  /** Delete a local-credential user. 404 if it does not exist. */
  async function deleteUser(email: string): Promise<{ email: string; deleted: true }> {
    const m = await models();
    const normalized = email.trim().toLowerCase();
    const result = await m.User.deleteOne({ email: normalized }).exec();
    if (result.deletedCount === 0) throw new AdminServiceError('User not found', 404, 'user_not_found');
    deps.logger?.info?.({ email: normalized }, 'admin deleted user');
    return { email: normalized, deleted: true };
  }

  // --- Invites (RQ-0013) ---

  /**
   * Mint a registration invite. Returns the plaintext code ONCE (only its digest is stored — the
   * same contract as client secrets). Roles are validated here, at the operator, so a bad vocabulary
   * fails loud at creation rather than quietly at the invitee's redemption (ADR-0013).
   */
  async function createInvite(input: CreateInviteInput): Promise<{ inviteId: string; code: string; expiresAt: Date }> {
    const m = await models();

    const email = input.email?.trim().toLowerCase();
    if (email !== undefined && !EMAIL_RE.test(email)) {
      throw new AdminServiceError('email must be a valid address', 400, 'invalid_email');
    }
    const roles = input.roles ?? [];
    const allowedRoles = CONFIG.auth.allowedRoles;
    if (allowedRoles.length) {
      const vocabulary = new Set(allowedRoles);
      const stray = roles.find((r) => !vocabulary.has(r));
      if (stray) throw new AdminServiceError(`Role "${stray}" is not in AUTH_ALLOWED_ROLES`, 400, 'invalid_input');
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
    deps.logger?.info?.({ inviteId, maxUses }, 'admin created invite');
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
      clients, users, lockedUsers, disabledUsers,
      tokensLastHour, tokensLastDay, activeRefresh, activeKeys
    ] = await Promise.all([
      m.OAuthClient.countDocuments({}).exec(),
      m.User.countDocuments({}).exec(),
      m.User.countDocuments({ lockedUntil: { $gt: now } }).exec(),
      m.User.countDocuments({ status: 'disabled' }).exec(),
      m.OAuthToken.countDocuments({ type: 'access', issuedAt: { $gte: hourAgo } }).exec(),
      m.OAuthToken.countDocuments({ type: 'access', issuedAt: { $gte: dayAgo } }).exec(),
      m.OAuthToken.countDocuments({ type: 'refresh', status: 'active' }).exec(),
      m.KeyStore.countDocuments({ status: 'active' }).exec()
    ]);

    return {
      clients: { total: clients },
      users: { total: users, locked: lockedUsers, disabled: disabledUsers },
      tokens: { accessLastHour: tokensLastHour, accessLastDay: tokensLastDay, activeRefresh },
      keys: { active: activeKeys },
      at: now.toISOString()
    };
  }

  return {
    listClients, createClient, rotateClientSecret, deleteClient,
    listUsers, createUser, resetUserPassword, setUserStatus, unlockUser, deleteUser,
    linkUserIdentity, unlinkUserIdentity,
    createInvite, listInvites, revokeInvite,
    rotateKey, keyStatus, getStats
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
