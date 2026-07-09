import { randomUUID } from 'crypto';
import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * A user's entitlement to an application (ADR-0019). One record per `(userId, clientId)` pair: it both
 * GATES issuance (a user with no active assignment for a client is denied a token — a hard, global gate)
 * and carries the app-scoped `roles` stamped into that app's token `roles` claim. Roles must be a subset
 * of the client's role catalogue (`oauth_clients.roles[].key`).
 *
 * `userId` is the user record `_id` (resolved regardless of local vs. federated login), NOT the token
 * `sub` — for a federated login the `sub` is the provider subject, so issuance resolves the user first,
 * then looks the assignment up by `_id`.
 *
 * Assignments do NOT apply to client-credentials (machine) tokens — those have no user.
 */
export interface AssignmentDocument extends Document<string> {
  _id: string;
  userId: string;   // User._id
  clientId: string; // OAuthClient._id
  roles: string[];  // app-scoped roles (subset of the client's catalogue)
  status: 'active' | 'suspended';
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const assignmentSchema = new mongoose.Schema<AssignmentDocument>({
  _id: { type: String, required: true, default: () => randomUUID() },
  userId: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  roles: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  createdBy: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// At most one assignment per user per application.
assignmentSchema.index({ userId: 1, clientId: 1 }, { unique: true });

export function getAssignmentModel(connection: Connection): Model<AssignmentDocument> {
  return (connection.models.Assignment as Model<AssignmentDocument>) ??
    connection.model<AssignmentDocument>('Assignment', assignmentSchema, 'assignments');
}

export const Assignment: Model<AssignmentDocument> =
  (mongoose.models.Assignment as Model<AssignmentDocument>) ??
  mongoose.model<AssignmentDocument>('Assignment', assignmentSchema, 'assignments');
