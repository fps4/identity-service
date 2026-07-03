import { randomUUID } from 'crypto';
import type { Connection } from 'mongoose';
import { CONFIG } from '../config.js';
import { hashSecret } from '../utils/hash.js';
import { inviteCodeDigest } from './invites.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { InviteDocument } from '../models/invite.js';
import type { Logger } from '../utils/logger.js';
import type { TenantOAuthConfig } from '../models/tenant.js';

const GRANT_PASSWORD = 'password';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A user/registration failure with an HTTP status + machine code (mapped by the route). */
export class UserServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface UserServiceDependencies {
  getMasterConnection: () => Promise<Connection>;
  makeModels: (connection: Connection) => ModelsBucket;
  now?: () => Date;
  logger?: Logger;
}

export interface RegisterUserInput {
  tenantId: string;
  email: string;
  password: string;
  inviteCode?: string;   // required when the tenant's oauth.registration is 'invite' (RQ-0013)
}

export interface RegisteredUser {
  id: string;     // the stable subject id (token `sub`)
  email: string;
  tenantId: string;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Validate a password against the configured policy. Throws `UserServiceError` (400) on failure. */
export function assertPasswordPolicy(password: string): void {
  const min = CONFIG.auth.password.minLength;
  if (typeof password !== 'string' || password.length < min) {
    throw new UserServiceError(`Password must be at least ${min} characters`, 400, 'weak_password');
  }
}

/**
 * Confirm a tenant permits local-credential user login (RQ-0002): active, OAuth enabled, the
 * `password` grant allowed, and the `local` IdP marked. Returns the tenant's OAuth config.
 */
export async function assertLocalIdpTenant(models: ModelsBucket, tenantId: string): Promise<TenantOAuthConfig> {
  const tenant = await models.Tenant.findOne({ _id: tenantId, status: 'active' }).lean().exec();
  if (!tenant) {
    throw new UserServiceError('Tenant inactive or missing', 404, 'tenant_not_found');
  }
  const oauthConfig = ((tenant as unknown as { oauth?: TenantOAuthConfig })?.oauth) ?? undefined;
  if (!oauthConfig?.enabled || !(oauthConfig.allowedGrantTypes ?? []).includes(GRANT_PASSWORD) || oauthConfig.idp?.provider !== 'local') {
    throw new UserServiceError('Local password login is not enabled for this tenant', 400, 'local_idp_disabled');
  }
  return oauthConfig;
}

export function createUserService(deps: UserServiceDependencies) {
  const nowFn = deps.now ?? (() => new Date());

  /**
   * Atomically claim one use of an invite (ADR-0013): a single conditional decrement, so two
   * registrations racing the last use cannot both pass. Every failure mode — unknown code, expired,
   * revoked, exhausted, wrong email binding — yields the same generic `invalid_invite`, so codes
   * cannot be probed for *why* they failed.
   */
  async function redeemInvite(models: ModelsBucket, tenantId: string, email: string, code: string, now: Date): Promise<InviteDocument> {
    const invalid = () => new UserServiceError('Invalid or expired invite code', 403, 'invalid_invite');
    const invite = await models.Invite.findOneAndUpdate(
      { tenantId, codeDigest: inviteCodeDigest(code), revokedAt: null, expiresAt: { $gt: now }, usesRemaining: { $gt: 0 } },
      { $inc: { usesRemaining: -1 }, $set: { updatedAt: now } },
      { new: true }
    ).exec();
    if (!invite) throw invalid();
    if (invite.email && invite.email !== email) {
      // Bound to a different address — hand the claimed use back before the (same, generic) denial.
      await refundInviteUse(models, invite._id, now);
      throw invalid();
    }
    return invite;
  }

  /** Return a claimed use after a downstream failure, so a rejected registration never burns one. */
  async function refundInviteUse(models: ModelsBucket, inviteId: string, now: Date): Promise<void> {
    await models.Invite.updateOne({ _id: inviteId }, { $inc: { usesRemaining: 1 }, $set: { updatedAt: now } }).exec();
  }

  async function registerUser(input: RegisterUserInput): Promise<RegisteredUser> {
    const email = normalizeEmail(input.email ?? '');
    if (!EMAIL_RE.test(email)) {
      throw new UserServiceError('A valid email is required', 400, 'invalid_email');
    }
    assertPasswordPolicy(input.password);

    const connection = await deps.getMasterConnection();
    const models = deps.makeModels(connection);
    const oauthConfig = await assertLocalIdpTenant(models, input.tenantId);

    // Registration policy gate (RQ-0013). Default `open` preserves pre-policy behaviour exactly.
    const policy = oauthConfig.registration ?? 'open';
    if (policy === 'closed') {
      throw new UserServiceError('Registration is closed for this tenant', 403, 'registration_closed');
    }
    if (policy === 'invite' && !input.inviteCode) {
      throw new UserServiceError('An invite code is required to register', 403, 'invite_required');
    }

    // Abuse guard on the public endpoint: cap registrations per tenant per minute. Ordered before
    // redemption so a throttled burst cannot burn invite uses.
    const windowStart = new Date(nowFn().getTime() - 60 * 1000);
    const recent = await models.User.countDocuments({ tenantId: input.tenantId, createdAt: { $gte: windowStart } }).exec();
    if (recent >= CONFIG.auth.password.registrationsPerMinute) {
      throw new UserServiceError('Too many registrations, retry shortly', 429, 'slow_down');
    }

    // Redeem before the duplicate-email lookup: on an invite tenant, only a valid code holder may
    // learn whether an email is taken (the RQ-0002 enumeration surface stops being public).
    const now = nowFn();
    const invite = policy === 'invite'
      ? await redeemInvite(models, input.tenantId, email, input.inviteCode!, now)
      : null;

    const existing = await models.User.findOne({ tenantId: input.tenantId, email }).lean().exec();
    if (existing) {
      if (invite) await refundInviteUse(models, invite._id, now);
      throw new UserServiceError('An account with this email already exists', 409, 'email_taken');
    }

    const id = randomUUID();
    try {
      await models.User.create({
        _id: id,
        tenantId: input.tenantId,
        email,
        passwordHash: hashSecret(input.password),
        status: 'active',
        // An email-bound invite vouches its address (ADR-0013): the operator sent the code there,
        // the same trust signal ADR-0012 accepts from Google's `email_verified`.
        emailVerified: Boolean(invite?.email),
        roles: invite?.roles ?? [],
        passwordUpdatedAt: now
      });
    } catch (err) {
      if (invite) await refundInviteUse(models, invite._id, now);
      throw err;
    }

    if (invite) {
      // Redemptions join the append-only trail (RQ-0013 AC); never let a logging failure undo a signup.
      try {
        await models.AuditLog.create({
          at: now,
          action: 'invite.redeem',
          method: 'POST',
          path: `/v1/tenants/${input.tenantId}/register`,
          targetType: 'invite',
          targetId: invite._id,
          status: 201,
          meta: { tenantId: input.tenantId, userId: id, email }
        });
      } catch (err) {
        deps.logger?.error?.({ err, inviteId: invite._id }, 'failed to audit invite redemption');
      }
    }

    deps.logger?.info?.({ tenantId: input.tenantId, userId: id, invited: Boolean(invite) }, 'registered local user');
    return { id, email, tenantId: input.tenantId };
  }

  return { registerUser };
}
