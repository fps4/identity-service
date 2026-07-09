import { randomUUID } from 'crypto';
import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * A role that exists *within* an application (ADR-0019, now app-level per ADR-0020). `key` is the stable
 * value stamped into the token `roles` claim for a user assigned this role; `name`/`description` are
 * console labels. The catalogue is the closed vocabulary an assignment's roles must be drawn from.
 */
export interface AppRole {
  key: string;
  name?: string;
  description?: string;
}

/**
 * An Application (ADR-0020) — a product. The first-class unit: it owns its name, its default token
 * `audience`, and its role catalogue, and it is the thing users are ASSIGNED to. OAuth clients are typed
 * CREDENTIALS *under* an application (`oauth_clients.applicationId`) that authenticate as it. This is a
 * grouping over the shared user pool (ADR-0018) — NOT a Tenant: it does not own or partition users.
 */
export interface ApplicationDocument extends Document<string> {
  _id: string;
  name: string;
  // Default token `aud` for tokens minted through this application's credentials. A credential may carry
  // its own `audience` override (e.g. a product runtime aimed at maestro-workspace).
  audience?: string;
  roles: AppRole[]; // the application's role catalogue
  createdAt?: Date;
  updatedAt?: Date;
}

const appRoleSchema = new mongoose.Schema<AppRole>({
  key: { type: String, required: true },
  name: { type: String },
  description: { type: String }
}, { _id: false });

const applicationSchema = new mongoose.Schema<ApplicationDocument>({
  _id: { type: String, required: true, default: () => randomUUID() },
  name: { type: String, required: true },
  audience: { type: String },
  roles: { type: [appRoleSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export function getApplicationModel(connection: Connection): Model<ApplicationDocument> {
  return (connection.models.Application as Model<ApplicationDocument>) ??
    connection.model<ApplicationDocument>('Application', applicationSchema, 'applications');
}

export const Application: Model<ApplicationDocument> =
  (mongoose.models.Application as Model<ApplicationDocument>) ??
  mongoose.model<ApplicationDocument>('Application', applicationSchema, 'applications');
