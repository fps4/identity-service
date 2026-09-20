import { randomUUID } from 'crypto';
import type { Connection } from 'mongoose';
import { CONFIG } from '../config.js';
import { hashSecret } from '../utils/hash.js';
import { inviteCodeDigest } from './invites.js';
import type { ModelsBucket } from '../oauth/types.js';
import type { InviteDocument } from '../models/invite.js';
import type { Logger } from '../utils/logger.js';
import { createRecorder, mintPrincipalId, realmOf, selfContext, withRecordTransaction, type Act, type RecordConfig } from '../record/index.js';

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
  /** maestro's record (ADR-0022). The container always wires it; optional only for unit tests. */
  record?: RecordConfig;
}

export interface RegisterUserInput {
  email: string;
  password: string;
  inviteCode?: string;   // required when AUTH_REGISTRATION_MODE is 'invite' (RQ-0013)
}

export interface RegisteredUser {
  id: string;     // the stable subject id (token `sub`)
  email: string;
  /** The person's maestro principal id (ADR-0022) — the `prn` claim their tokens will carry. */
  principalId?: string;
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
    const record = deps.record;
    const user = {
      _id: id,
      email,
      passwordHash: hashSecret(input.password),
      status: 'active' as const,
      // An email-bound invite vouches its address (ADR-0013): the operator sent the code there,
      // the same trust signal ADR-0012 accepts from Google's `email_verified`.
      emailVerified: Boolean(invite?.email),
      passwordUpdatedAt: now
    };
    // An invite entitles the redeemer to its application (ADR-0019): the assignment that grants access +
    // the app-scoped roles. Without it a fresh account can obtain no token (global gate).
    const assignment = invite ? {
      _id: randomUUID(),
      userId: id,
      applicationId: invite.applicationId,
      roles: invite.roles ?? [],
      status: 'active' as const,
      createdBy: `invite:${invite._id}`,
      createdAt: now,
      updatedAt: now
    } : null;

    let principalId: string | undefined;
    if (record) {
      // The person's maestro principal (ADR-0022): registered on maestro's record in the same transaction
      // as the account, by themselves, in the `self` seat. An invite's roles are seats on its application,
      // granted to the new principal in the same breath and chained to the registration by causation.
      principalId = mintPrincipalId('human');
      const prn = principalId;
      const acts: Act[] = [{
        type: 'PrincipalRegistered',
        subject: prn,
        body: { kind: 'human', source: 'local', realm: realmOf(record.workspaceId) }
      }];
      for (const role of assignment?.roles ?? []) {
        acts.push({
          type: 'SeatOccupancyChanged',
          subject: prn,
          body: { seat: role, application: assignment!.applicationId, change: 'granted', oversight_level: 'O0' }
        });
      }
      try {
        await withRecordTransaction(connection, async (session) => {
          await models.User.create([{ ...user, principalId: prn }], { session });
          await models.Principal.create([{ _id: prn, kind: 'human', status: 'active', subjectType: 'user', subjectId: id, createdAt: now, updatedAt: now }], { session });
          if (assignment) await models.Assignment.create([assignment], { session });
          const recorder = createRecorder({ models, config: record, ...selfContext({ id: prn, kind: 'human' }), logger: deps.logger, now: () => now.toISOString() });
          await recorder.emit(session, acts);
        }, deps.logger);
      } catch (err) {
        // Without transaction support a half-written registration is unwound by hand, as before.
        await models.Assignment.deleteOne({ _id: assignment?._id ?? '' }).exec().catch(() => {});
        await models.User.deleteOne({ _id: id }).exec().catch(() => {});
        await models.Principal.deleteOne({ _id: prn }).exec().catch(() => {});
        if (invite) await refundInviteUse(models, invite._id, now);
        throw err;
      }
    } else {
      try {
        await models.User.create(user);
      } catch (err) {
        if (invite) await refundInviteUse(models, invite._id, now);
        throw err;
      }
      // If this fails, unwind the account + invite use so the redeemer can retry cleanly.
      if (assignment) {
        try {
          await models.Assignment.create(assignment);
        } catch (err) {
          await models.User.deleteOne({ _id: id }).exec().catch(() => {});
          await refundInviteUse(models, invite!._id, now);
          deps.logger?.error?.({ err, inviteId: invite!._id }, 'failed to create assignment on invite redemption');
          throw new UserServiceError('Could not complete registration, retry shortly', 500, 'assignment_failed');
        }
      }
    }

    if (invite) {
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
          meta: { userId: id, email, applicationId: invite.applicationId, roles: invite.roles ?? [] }
        });
      } catch (err) {
        deps.logger?.error?.({ err, inviteId: invite._id }, 'failed to audit invite redemption');
      }
    }

    deps.logger?.info?.({ userId: id, principalId, invited: Boolean(invite) }, 'registered local user');
    return { id, email, ...(principalId ? { principalId } : {}) };
  }

  return { registerUser };
}
