import { randomUUID } from 'crypto';
import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * An operator-issued registration invite (RQ-0013, ADR-0013). Gates self-registration when the
 * deployment's `AUTH_REGISTRATION_MODE` is `invite`: the operator mints a code on the management plane
 * and distributes it out-of-band; the invitee presents it to `POST /v1/register`.
 *
 * Only the SHA-256 digest of the show-once code is stored — deterministic (NOT salted scrypt)
 * because redemption must look the invite up by presented value, the same trade `oauth_tokens`
 * makes for refresh tokens. Safety rests on the code's CSPRNG entropy (ADR-0013): shortening codes
 * or making them human-chosen re-opens offline guessing and must be re-decided there.
 *
 * Remaining capacity is a countdown (`usesRemaining`, initialized to `maxUses`) so redemption is a
 * single conditional decrement — two registrations racing the last use cannot both match. The
 * ADR-0013 `usedCount` surfaces derived (`maxUses - usesRemaining`) on the admin plane.
 */
export interface InviteDocument extends Document<string> {
  _id: string;
  applicationId: string;     // the application the redeemer is entitled to (ADR-0019, ADR-0020)
  codeDigest: string;        // sha256 of the canonicalized code; unique — the redemption lookup key
  email?: string | null;     // optional binding (lowercased); redemption then requires this email and vouches it
  roles: string[];           // app-scoped roles granted on redemption; validated against the client's catalogue
  maxUses: number;
  usesRemaining: number;
  expiresAt: Date;
  revokedAt?: Date | null;
  createdBy?: string;        // acting principal (operator sub or client id) for the audit trail
  note?: string;             // operator memo, e.g. "March cohort"
  createdAt?: Date;
  updatedAt?: Date;
}

const inviteSchema = new mongoose.Schema<InviteDocument>({
  _id: { type: String, required: true, default: () => randomUUID() },
  applicationId: { type: String, required: true, index: true },
  codeDigest: { type: String, required: true, unique: true },
  email: { type: String, lowercase: true, trim: true, default: null },
  roles: { type: [String], default: [] },
  maxUses: { type: Number, required: true, min: 1 },
  usesRemaining: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  createdBy: { type: String },
  note: { type: String, maxlength: 256 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export function getInviteModel(connection: Connection): Model<InviteDocument> {
  return (connection.models.Invite as Model<InviteDocument>) ??
    connection.model<InviteDocument>('Invite', inviteSchema, 'invites');
}

export const Invite: Model<InviteDocument> =
  (mongoose.models.Invite as Model<InviteDocument>) ??
  mongoose.model<InviteDocument>('Invite', inviteSchema, 'invites');
