import { randomUUID } from 'crypto';
import type { Connection } from 'mongoose';
import { CONFIG } from '../config.js';
import { hashSecret } from '../utils/hash.js';
import { inviteCodeDigest } from './invites.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { InviteDocument } from '../models/invite.js';
import type { Logger } from '../utils/logger.js';

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
  email: string;
  password: string;
  inviteCode?: string;   // required when AUTH_REGISTRATION_MODE is 'invite' (RQ-0013)
}

export interface RegisteredUser {
  id: string;     // the stable subject id (token `sub`)
  email: string;
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
 * Confirm the deployment permits local-credential (email/password) registration + login (RQ-0002).
 * Gated by AUTH_LOCAL_IDP_ENABLED (ADR-0018 — formerly the per-tenant `oauth.idp.provider: local`).
 */
export function assertLocalIdpEnabled(): void {
  if (!CONFIG.auth.localIdpEnabled) {
    throw new UserServiceError('Local password login is not enabled', 400, 'local_idp_disabled');
  }
}

export function createUserService(deps: UserServiceDependencies) {
  const nowFn = deps.now ?? (() => new Date());

  /**
   * Atomically claim one use of an invite (ADR-0013): a single conditional decrement, so two
   * registrations racing the last use cannot both pass. Every failure mode — unknown code, expired,
   * revoked, exhausted, wrong email binding — yields the same generic `invalid_invite`, so codes
   * cannot be probed for *why* they failed.
   */
  async function redeemInvite(models: ModelsBucket, email: string, code: string, now: Date): Promise<InviteDocument> {
    const invalid = () => new UserServiceError('Invalid or expired invite code', 403, 'invalid_invite');
    const invite = await models.Invite.findOneAndUpdate(
      { codeDigest: inviteCodeDigest(code), revokedAt: null, expiresAt: { $gt: now }, usesRemaining: { $gt: 0 } },
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
    assertLocalIdpEnabled();

    // Registration policy gate (RQ-0013). Default `open` preserves pre-policy behaviour exactly.
    const policy = CONFIG.auth.registrationMode;
    if (policy === 'closed') {
      throw new UserServiceError('Registration is closed', 403, 'registration_closed');
    }
    if (policy === 'invite' && !input.inviteCode) {
      throw new UserServiceError('An invite code is required to register', 403, 'invite_required');
    }

    // Abuse guard on the public endpoint: cap registrations per minute. Ordered before redemption so a
    // throttled burst cannot burn invite uses.
    const windowStart = new Date(nowFn().getTime() - 60 * 1000);
    const recent = await models.User.countDocuments({ createdAt: { $gte: windowStart } }).exec();
    if (recent >= CONFIG.auth.password.registrationsPerMinute) {
      throw new UserServiceError('Too many registrations, retry shortly', 429, 'slow_down');
    }

    // Redeem before the duplicate-email lookup: on an invite deployment, only a valid code holder may
    // learn whether an email is taken (the RQ-0002 enumeration surface stops being public).
    const now = nowFn();
    const invite = policy === 'invite'
      ? await redeemInvite(models, email, input.inviteCode!, now)
      : null;

    const existing = await models.User.findOne({ email }).lean().exec();
    if (existing) {
      if (invite) await refundInviteUse(models, invite._id, now);
      throw new UserServiceError('An account with this email already exists', 409, 'email_taken');
    }

    const id = randomUUID();
    try {
      await models.User.create({
        _id: id,
        email,
        passwordHash: hashSecret(input.password),
        status: 'active',
        // An email-bound invite vouches its address (ADR-0013): the operator sent the code there,
        // the same trust signal ADR-0012 accepts from Google's `email_verified`.
        emailVerified: Boolean(invite?.email),
        passwordUpdatedAt: now
      });
    } catch (err) {
      if (invite) await refundInviteUse(models, invite._id, now);
      throw err;
    }

    // An invite entitles the redeemer to its application (ADR-0019): create the assignment that grants
    // access + the app-scoped roles. Without it a fresh account can obtain no token (global gate). If
    // this fails, unwind the account + invite use so the redeemer can retry cleanly.
    if (invite) {
      try {
        await models.Assignment.create({
          _id: randomUUID(),
          userId: id,
          clientId: invite.clientId,
          roles: invite.roles ?? [],
          status: 'active',
          createdBy: `invite:${invite._id}`,
          createdAt: now,
          updatedAt: now
        });
      } catch (err) {
        await models.User.deleteOne({ _id: id }).exec().catch(() => {});
        await refundInviteUse(models, invite._id, now);
        deps.logger?.error?.({ err, inviteId: invite._id }, 'failed to create assignment on invite redemption');
        throw new UserServiceError('Could not complete registration, retry shortly', 500, 'assignment_failed');
      }

      // Redemptions join the append-only trail (RQ-0013 AC); never let a logging failure undo a signup.
      try {
        await models.AuditLog.create({
          at: now,
          action: 'invite.redeem',
          method: 'POST',
          path: '/v1/register',
          targetType: 'invite',
          targetId: invite._id,
          status: 201,
          meta: { userId: id, email, clientId: invite.clientId, roles: invite.roles ?? [] }
        });
      } catch (err) {
        deps.logger?.error?.({ err, inviteId: invite._id }, 'failed to audit invite redemption');
      }
    }

    deps.logger?.info?.({ userId: id, invited: Boolean(invite) }, 'registered local user');
    return { id, email };
  }

  return { registerUser };
}
