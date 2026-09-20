import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * The principal registry (ADR-0022): maestro's view of everyone this deployment can authenticate.
 *
 * A **principal** is anyone or anything that acts and is recorded — a **human** (a user in the pool),
 * an **agent** (a client-credentials credential an AI runtime authenticates with) or a **workload** (a
 * client-credentials credential a deployed service authenticates with). Its `_id` is the maestro
 * principal id — `prn-h-…` / `prn-a-…` / `prn-w-…`, the kind letter then lower-case Crockford base32 —
 * and it is the ONLY identifier of a person or a machine that ever reaches maestro's record. A token
 * `sub`, an email, a client id: none of them leaves this service.
 *
 * The row outlives what it points at. Deleting a user or a credential RETIRES its principal here rather
 * than removing it, because events already in maestro's archive name the id, and a relay that could no
 * longer resolve it would refuse them — the archive must be able to say what kind of thing acted, for
 * as long as it holds the event. `status` mirrors the subject's: active, suspended (disabled), retired
 * (deleted). Nothing reads it for authorisation; the user's/credential's own record still gates that.
 */
export type PrincipalKind = 'human' | 'agent' | 'workload';
export type PrincipalStatus = 'active' | 'suspended' | 'retired';

export interface PrincipalDocument extends Document<string> {
  _id: string;                       // the maestro principal id: prn-h-… | prn-a-… | prn-w-…
  kind: PrincipalKind;
  status: PrincipalStatus;
  subjectType: 'user' | 'client';    // which collection the principal is bound to
  subjectId: string;                 // User._id or OAuthClient._id — a binding, never copied onto an event
  createdAt?: Date;
  updatedAt?: Date;
}

const principalSchema = new mongoose.Schema<PrincipalDocument>({
  _id: { type: String, required: true },
  kind: { type: String, enum: ['human', 'agent', 'workload'], required: true },
  status: { type: String, enum: ['active', 'suspended', 'retired'], default: 'active', required: true },
  subjectType: { type: String, enum: ['user', 'client'], required: true },
  subjectId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

// One principal per user or credential — the binding is one-to-one, so a lazy backfill racing itself
// cannot mint two ids for one record.
principalSchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });

export function getPrincipalModel(connection: Connection): Model<PrincipalDocument> {
  return (connection.models.Principal as Model<PrincipalDocument>) ??
    connection.model<PrincipalDocument>('Principal', principalSchema, 'principals');
}

export const Principal: Model<PrincipalDocument> =
  (mongoose.models.Principal as Model<PrincipalDocument>) ??
  mongoose.model<PrincipalDocument>('Principal', principalSchema, 'principals');
