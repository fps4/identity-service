import { randomUUID } from 'crypto';
import mongoose, { Connection, Document, Model } from 'mongoose';

/**
 * An OAuth client — a CREDENTIAL under an application (ADR-0020). A product's web frontend, backend
 * runtime, and CI principals are all credentials under one `applicationId`; the application owns the role
 * catalogue and the default audience. A credential of grant type `password`/`authorization_code` is a
 * user-login credential; `client_credentials` is a machine/runtime credential.
 */
export interface OAuthClientDocument extends Document<string> {
  _id: string; // client_id
  applicationId: string; // the Application this credential belongs to (ADR-0020)
  name: string;
  secretHash: string;
  grantTypes: string[];
  redirectUris: string[];
  scopes: string[];
  isConfidential: boolean;
  // An OPTIONAL per-credential `aud` OVERRIDE (ADR-0020). Normally the token `aud` is inherited from the
  // application's `audience`; a credential sets this only when it must differ — e.g. a product runtime
  // whose token is aimed at `maestro-workspace` rather than its own application's audience.
  audience?: string;
  // The `sub` a client-credentials token carries (US-0086). For a product_runtime credential this is the
  // deployment's runtime principal (e.g. `runtime@sovereign-llm-gateway.fps4.nl`) that the resource
  // server (maestro) resolves against its register. Falls back to the client id when unset.
  subject?: string;
  // Extra, additive claims merged into a client-credentials token (US-0086) — e.g.
  // `{ role: 'product_runtime', email: 'runtime@…' }` so the resource server can match its principal.
  // Registered claims (`iss`/`aud`/`exp`/`sub`/…) are always set by the signer and cannot be overridden.
  claims?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

const oauthClientSchema = new mongoose.Schema<OAuthClientDocument>({
  _id: { type: String, required: true, default: () => randomUUID() },
  applicationId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  secretHash: { type: String, required: true },
  grantTypes: { type: [String], default: [] },
  redirectUris: { type: [String], default: [] },
  scopes: { type: [String], default: [] },
  isConfidential: { type: Boolean, default: true },
  audience: { type: String },
  subject: { type: String },
  claims: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export function getOAuthClientModel(connection: Connection): Model<OAuthClientDocument> {
  return (connection.models.OAuthClient as Model<OAuthClientDocument>) ??
    connection.model<OAuthClientDocument>('OAuthClient', oauthClientSchema, 'oauth_clients');
}

export const OAuthClient: Model<OAuthClientDocument> =
  (mongoose.models.OAuthClient as Model<OAuthClientDocument>) ??
  mongoose.model<OAuthClientDocument>('OAuthClient', oauthClientSchema, 'oauth_clients');
