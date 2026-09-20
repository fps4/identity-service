import { randomUUID } from 'crypto';
import { CONFIG } from '../config.js';
import { hashSecret } from '../utils/hash.js';
import { inviteCodeDigest } from './invites.js';
import type { AssignmentDocument, InviteDocument, UserDocument } from '../models/index.js';
import type { Logger } from '../utils/logger.js';
import { ConditionFailed, type Store, type Transaction } from '../db/index.js';
import { createRecorder, mintPrincipalId, principalRow, realmOf, selfContext, withRecordTransaction, type Act, type RecordConfig } from '../record/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** A user/registration failure with an HTTP status + machine code (mapped by the route). */
export class UserServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface UserServiceDependencies {
  /** The table (ADR-0023). Injectable so tests drive the service over a table of their own. */
  store: Store;
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
  const { store } = deps;

  /**
   * The invite a presented code names, if it can still be redeemed (ADR-0013). Every failure mode —
   * unknown code, expired, revoked, exhausted, wrong email binding — yields the same generic
   * `invalid_invite`, so codes cannot be probed for *why* they failed. The use itself is claimed in the
   * registration's transaction (`store.invites.redeem`): a single conditional decrement, so two
   * registrations racing the last use cannot both pass, and a registration refused later in that
   * transaction never took the use at all.
   */
  async function redeemableInvite(email: string, code: string, now: Date): Promise<InviteDocument> {
    const invalid = () => new UserServiceError('Invalid or expired invite code', 403, 'invalid_invite');
    const invite = await store.invites.getByDigest(inviteCodeDigest(code));
    if (!invite || invite.revokedAt || invite.expiresAt.getTime() <= now.getTime() || invite.usesRemaining <= 0) throw invalid();
    if (invite.email && invite.email !== email) throw invalid();
    return invite;
  }

  async function registerUser(input: RegisterUserInput): Promise<RegisteredUser> {
    const email = normalizeEmail(input.email ?? '');
    if (!EMAIL_RE.test(email)) {
      throw new UserServiceError('A valid email is required', 400, 'invalid_email');
    }
    assertPasswordPolicy(input.password);
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
    const recent = await store.users.countCreatedSince(windowStart);
    if (recent >= CONFIG.auth.password.registrationsPerMinute) {
      throw new UserServiceError('Too many registrations, retry shortly', 429, 'slow_down');
    }

    // Resolve the invite before the duplicate-email lookup: on an invite deployment, only a valid code
    // holder may learn whether an email is taken (the RQ-0002 enumeration surface stops being public).
    const now = nowFn();
    const invite = policy === 'invite'
      ? await redeemableInvite(email, input.inviteCode!, now)
      : null;

    const existing = await store.users.getByEmail(email);
    if (existing) {
      throw new UserServiceError('An account with this email already exists', 409, 'email_taken');
    }

    const id = randomUUID();
    const record = deps.record;
    const principalId = record ? mintPrincipalId('human') : undefined;
    const user: UserDocument = {
      _id: id,
      email,
      passwordHash: hashSecret(input.password),
      status: 'active',
      identities: [],
      failedAttempts: 0,
      // An email-bound invite vouches its address (ADR-0013): the operator sent the code there,
      // the same trust signal ADR-0012 accepts from Google's `email_verified`.
      emailVerified: Boolean(invite?.email),
      passwordUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
      ...(principalId ? { principalId } : {})
    };
    // An invite entitles the redeemer to its application (ADR-0019): the assignment that grants access +
    // the app-scoped roles. Without it a fresh account can obtain no token (global gate).
    const assignment: AssignmentDocument | null = invite ? {
      userId: id,
      applicationId: invite.applicationId,
      roles: invite.roles ?? [],
      status: 'active',
      createdBy: `invite:${invite._id}`,
      createdAt: now,
      updatedAt: now
    } : null;

    // The person's maestro principal (ADR-0022): registered on maestro's record in the same transaction
    // as the account, by themselves, in the `self` seat. An invite's roles are seats on its application,
    // granted to the new principal in the same breath and chained to the registration by causation.
    const acts: Act[] = [];
    if (record && principalId) {
      acts.push({ type: 'PrincipalRegistered', subject: principalId, body: { kind: 'human', source: 'local', realm: realmOf(record.workspaceId) } });
      for (const role of assignment?.roles ?? []) {
        acts.push({ type: 'SeatOccupancyChanged', subject: principalId, body: { seat: role, application: assignment!.applicationId, change: 'granted', oversight_level: 'O0' } });
      }
    }
    try {
      await withRecordTransaction(store, async (tx: Transaction) => {
        if (invite) store.invites.redeem(tx, invite._id, now);
        store.users.put(tx, user);
        if (assignment) store.assignments.put(tx, assignment);
        if (record && principalId) {
          store.principals.register(tx, principalRow(principalId, 'human', 'active', 'user', id, now));
          const recorder = createRecorder({ store, config: record, ...selfContext({ id: principalId, kind: 'human' }), logger: deps.logger, now: () => now.toISOString() });
          await recorder.emit(tx, acts);
        }
      }, deps.logger);
    } catch (err) {
      // The transaction is all or nothing: a taken email or a spent invite leaves no account and no
      // burnt use behind. The answers are the ones the reads above would have given a moment earlier.
      if (err instanceof ConditionFailed && err.label === 'email') throw new UserServiceError('An account with this email already exists', 409, 'email_taken');
      if (err instanceof ConditionFailed && err.label === 'invite') throw new UserServiceError('Invalid or expired invite code', 403, 'invalid_invite');
      throw err;
    }

    if (invite) {
      // Redemptions join the append-only trail (RQ-0013 AC); never let a logging failure undo a signup.
      try {
        await store.audit.create({
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
