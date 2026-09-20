import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * Monotonic counters for the outbox (ADR-0022): `outbox:<workspace_id>` is the workspace's event
 * sequence; `subject:<principal id>` is the per-subject sequence. Both are allocated with a single
 * `$inc` inside the emitting transaction, so the order of the record is decided where the change is
 * made and never by when a relay happened to read it.
 */
export interface CounterDocument extends Document<string> {
  _id: string;
  value: number;
}

const counterSchema = new mongoose.Schema<CounterDocument>({
  _id: { type: String, required: true },
  value: { type: Number, required: true, default: 0 }
}, { versionKey: false });

export function getCounterModel(connection: Connection): Model<CounterDocument> {
  return (connection.models.Counter as Model<CounterDocument>) ??
    connection.model<CounterDocument>('Counter', counterSchema, 'counters');
}

export const Counter: Model<CounterDocument> =
  (mongoose.models.Counter as Model<CounterDocument>) ??
  mongoose.model<CounterDocument>('Counter', counterSchema, 'counters');
