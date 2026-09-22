/**
 * Set-password links: how a person who already exists comes to hold a password nobody else has seen.
 *
 * An operator seeds or creates a user — a password the operator chose, or a random one nobody keeps —
 * and issues a link. The link carries a show-once token (only its digest is stored, ADR-0013's rule
 * for anything that must be findable by value); it is handed over out of band, like an invite; it
 * expires; and it is redeemed once, inside the transaction that sets the password. The person who
 * opens it types the password on the service's own page and never learns a temporary one. Setting a
 * password this way vouches the address the operator sent the link to, as an invite does.
 *
 * Nothing here reaches maestro's record: a credential is the realm's, not the record's (ADR-0022).
 */
import { randomBytes } from 'crypto';
import { CONFIG } from '../config.js';
import type { PasswordLinkDocument } from '../db/password-links.js';
import { Transaction, type Store } from '../db/index.js';
import { hashSecret, sha256Hex } from '../utils/hash.js';
import { assertPasswordPolicy, UserServiceError } from './users.js';

export const DEFAULT_LINK_HOURS = 24;
const MAX_LINK_HOURS = 24 * 7;

export interface PasswordLinkDeps {
  store: Store;
  /** The public base the link is built on; the issuer by default. */
  issuer?: string;
  now?: () => Date;
}

export interface IssuedPasswordLink {
  url: string;
  token: string;
  email: string;
  expiresAt: Date;
}

export const passwordLinkDigest = (token: string): string => sha256Hex(token);

/** The path the link opens; the route that serves it lives in routes/password-routes.ts. */
export const PASSWORD_PATH = '/password';

export function createPasswordLinkService(deps: PasswordLinkDeps) {
  const { store } = deps;
  const nowFn = deps.now ?? (() => new Date());
  const base = () => (deps.issuer ?? CONFIG.auth.jwtIssuer).replace(/\/+$/, '');

  return {
    /** Issue a link for an existing user, by email or id. Returned once; only the digest is stored. */
    async issue(input: { email?: string; userId?: string; hours?: number; createdBy?: string }): Promise<IssuedPasswordLink> {
      const hours = input.hours ?? DEFAULT_LINK_HOURS;
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_LINK_HOURS) {
        throw new UserServiceError(`A link lives between one hour and ${MAX_LINK_HOURS}`, 400, 'invalid_input');
      }
      const user = input.userId
        ? await store.users.get(input.userId)
        : input.email
          ? await store.users.getByEmail(input.email.trim().toLowerCase())
          : null;
      if (!user) throw new UserServiceError('User not found', 404, 'user_not_found');
      if (user.status === 'disabled') throw new UserServiceError('The user is disabled', 409, 'user_disabled');

      const now = nowFn();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + hours * 3600_000);
      const tx = new Transaction();
      store.passwordLinks.create(tx, {
        _id: passwordLinkDigest(token),
        userId: user._id,
        expiresAt,
        createdAt: now,
        ...(input.createdBy ? { createdBy: input.createdBy } : {})
      });
      await store.commit(tx);
      return { url: `${base()}${PASSWORD_PATH}?token=${token}`, token, email: user.email, expiresAt };
    },

    /** What a page may show before the password is typed: whose link this is, or nothing. */
    async peek(token: string): Promise<{ email: string } | null> {
      const link = await store.passwordLinks.get(passwordLinkDigest(token));
      if (!link || link.expiresAt.getTime() <= nowFn().getTime()) return null;
      const user = await store.users.get(link.userId);
      return user && user.status !== 'disabled' ? { email: user.email } : null;
    },

    /**
     * Redeem: the password set and the link consumed in one transaction. Every failure of the link
     * itself is the one sentence — a link is not probed into telling why.
     */
    async redeem(input: { token: string; password: string }): Promise<{ email: string }> {
      assertPasswordPolicy(input.password);
      const digest = passwordLinkDigest(input.token ?? '');
      const link = input.token ? await store.passwordLinks.get(digest) : null;
      const now = nowFn();
      const invalid = () => new UserServiceError('This link is not valid any more.', 400, 'invalid_link');
      if (!link || link.expiresAt.getTime() <= now.getTime()) throw invalid();
      const user = await store.users.get(link.userId);
      if (!user || user.status === 'disabled') throw invalid();

      const tx = new Transaction();
      store.passwordLinks.consume(tx, digest, now);
      store.users.updateIn(tx, user._id, {
        passwordHash: hashSecret(input.password),
        passwordUpdatedAt: now,
        failedAttempts: 0,
        lockedUntil: null,
        emailVerified: true,
        ...(user.status === 'locked' ? { status: 'active' as const } : {}),
        updatedAt: now
      });
      try {
        await store.commit(tx);
      } catch {
        // The condition failed: consumed a moment ago, or expired between the read and the write.
        throw invalid();
      }
      return { email: user.email };
    }
  };
}

export type PasswordLinkService = ReturnType<typeof createPasswordLinkService>;
