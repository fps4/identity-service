import { randomUUID } from 'crypto';
import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * A person in the deployment's user pool (RQ-0002, RQ-0011, ADR-0018). Provider-agnostic: a user may
 * carry a local email/password credential (RQ-0002), one or more federated identities (RQ-0011 — e.g.
 * Google SSO, RQ-0001), or both. Whatever the provider, authentication issues the same RS256 user token
 * (`email` + stable `sub`) maestro verifies.
 *
 * `_id` is a stable, immutable id minted at creation (NOT the email). For a **local** login the token
 * `sub` is this `_id`; for a **federated** login the token `sub` is the *provider* subject (the Google
 * `sub`), preserved verbatim to satisfy the RQ-0001 fixed contract (ADR-0012). This record is therefore
 * a resolution layer *behind* the token — it never changes the emitted claims. `status`/lockout apply to
 * the person regardless of how they authenticated. Roles are NOT on the user: they are per-application
 * and live on the `assignments` collection (ADR-0019).
 *
 * `passwordHash` is OPTIONAL: a federated-only user has none (and cannot password-login). When present
 * it uses the salted scrypt scheme in `utils/hash.ts`; the raw password is never stored.
 */
export interface FederatedIdentity {
  provider: 'google';       // the upstream IdP (only Google today; RQ-0001)
  subject: string;          // the provider's stable subject — becomes the token `sub` for this login
  email?: string;           // the email the provider asserted (informational; may differ from user.email)
  emailVerified: boolean;   // whether the provider vouched the email — the linking gate (RQ-0011 US-4)
  linkedAt: Date;
}

export interface UserDocument extends Document<string> {
  _id: string;              // stable subject id (the token `sub` for local logins)
  email: string;            // unique within the deployment (stored lowercased)
  passwordHash?: string;    // optional — absent for federated-only users
  identities: FederatedIdentity[]; // linked upstream IdP identities (RQ-0011)
  emailVerified: boolean;   // whether the email is vouched (by a provider or, later, a verify channel)
  status: 'active' | 'locked' | 'disabled';
  failedAttempts: number;
  lockedUntil?: Date | null;
  passwordUpdatedAt?: Date;
  lastLoginAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const federatedIdentitySchema = new mongoose.Schema<FederatedIdentity>({
  provider: { type: String, enum: ['google'], required: true },
  subject: { type: String, required: true },
  email: { type: String, lowercase: true, trim: true },
  emailVerified: { type: Boolean, default: false },
  linkedAt: { type: Date, default: Date.now }
}, { _id: false });

const userSchema = new mongoose.Schema<UserDocument>({
  _id: { type: String, required: true, default: () => randomUUID() },
  email: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String },
  identities: { type: [federatedIdentitySchema], default: [] },
  emailVerified: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'locked', 'disabled'], default: 'active', index: true },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  passwordUpdatedAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// One account per email within the deployment (ADR-0018: one realm per deployment).
userSchema.index({ email: 1 }, { unique: true });

// A given upstream identity (provider + subject) links to at most one user in the deployment (RQ-0011).
// Partial so password-only users (no identities) are not indexed and cannot collide on null keys.
userSchema.index(
  { 'identities.provider': 1, 'identities.subject': 1 },
  { unique: true, partialFilterExpression: { 'identities.provider': { $exists: true } } }
);

export function getUserModel(connection: Connection): Model<UserDocument> {
  return (connection.models.User as Model<UserDocument>) ??
    connection.model<UserDocument>('User', userSchema, 'users');
}

export const User: Model<UserDocument> =
  (mongoose.models.User as Model<UserDocument>) ??
  mongoose.model<UserDocument>('User', userSchema, 'users');
