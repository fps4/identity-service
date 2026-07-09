import mongoose, { Connection, Document, Model } from 'mongoose';

export interface SessionDocument extends Document<string> {
  _id: string;
  visitorId?: string | null;
  contactId?: string | null;
  context?: Record<string, unknown> | null;
  status: 'active' | 'revoked';
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const sessionSchema = new mongoose.Schema<SessionDocument>({
  _id: { type: String, required: true },
  visitorId: { type: String, default: null },
  contactId: { type: String, default: null },
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export function getSessionModel(connection: Connection): Model<SessionDocument> {
  return (connection.models.Session as Model<SessionDocument>) ??
    connection.model<SessionDocument>('Session', sessionSchema);
}

export const Session: Model<SessionDocument> =
  (mongoose.models.Session as Model<SessionDocument>) ??
  mongoose.model<SessionDocument>('Session', sessionSchema);
