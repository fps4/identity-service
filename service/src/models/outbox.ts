import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * The transactional outbox (ADR-0022): maestro's spine envelope, written in the same transaction as the
 * change it records, plus the relay's bookkeeping.
 *
 * The row IS the envelope. `emit()` builds it at the act, validates it with the spine's own rules and
 * inserts it beside the change; the relay reads it, archives it unchanged and acknowledges it. Nothing
 * downstream joins a row to whatever the registry or the configuration say later — attribution is fixed
 * where the act happened, which is the only place it is known. The envelope's fields are the spine's
 * (`@fps4/maestro-spine`, `eventSchema`); the three bookkeeping fields are ours and are stripped before
 * an event leaves this service.
 */
export interface OutboxDocument extends Document<string> {
  _id: string;                 // = event_id, so the relay's acknowledgement is a primary-key update
  event_id: string;            // UUIDv7, minted at emit
  workspace_id: string;        // ws-… — this deployment's workspace on maestro's record
  seq: number;                 // monotonic per workspace, assigned in the emitting transaction
  subject_type: string;        // always `principal` here
  subject_id: string;          // the principal's maestro id
  subject_seq: number;         // per subject; optimistic concurrency for a projection
  type: string;
  type_version: number;
  occurred_at: string;
  recorded_at: string;
  accountable: string;         // a human principal — always
  acting: string;              // who performed the act — may be an agent or a workload
  seat: string;
  oversight_level: string;
  consequence_class: string;
  causation_id: string | null;
  correlation_id: string;
  body: Record<string, unknown>;
  payload_ref?: string;
  payload_digest?: string;
  // --- the relay's bookkeeping; never part of the event ---
  delivered: boolean;
  delivered_at?: string;
  attempts: number;
}

const outboxSchema = new mongoose.Schema<OutboxDocument>({
  _id: { type: String, required: true },
  event_id: { type: String, required: true },
  workspace_id: { type: String, required: true },
  seq: { type: Number, required: true },
  subject_type: { type: String, required: true },
  subject_id: { type: String, required: true },
  subject_seq: { type: Number, required: true },
  type: { type: String, required: true },
  type_version: { type: Number, required: true },
  occurred_at: { type: String, required: true },
  recorded_at: { type: String, required: true },
  accountable: { type: String, required: true },
  acting: { type: String, required: true },
  seat: { type: String, required: true },
  oversight_level: { type: String, required: true },
  consequence_class: { type: String, required: true },
  causation_id: { type: String, default: null },
  correlation_id: { type: String, required: true },
  body: { type: mongoose.Schema.Types.Mixed, required: true },
  payload_ref: { type: String },
  payload_digest: { type: String },
  delivered: { type: Boolean, default: false, required: true },
  delivered_at: { type: String },
  attempts: { type: Number, default: 0, required: true }
}, { versionKey: false, minimize: false });

// `seq` is the record's order and is unique per workspace by construction; the index makes a double
// allocation a database error rather than a silent gap the relay refuses later.
outboxSchema.index({ workspace_id: 1, seq: 1 }, { unique: true });
// The relay's read: undelivered, oldest first.
outboxSchema.index({ delivered: 1, workspace_id: 1, seq: 1 });

export function getOutboxModel(connection: Connection): Model<OutboxDocument> {
  return (connection.models.Outbox as Model<OutboxDocument>) ??
    connection.model<OutboxDocument>('Outbox', outboxSchema, 'outbox');
}

export const Outbox: Model<OutboxDocument> =
  (mongoose.models.Outbox as Model<OutboxDocument>) ??
  mongoose.model<OutboxDocument>('Outbox', outboxSchema, 'outbox');
