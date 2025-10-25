import mongoose, { Connection, Document, Model } from 'mongoose';

const { Schema } = mongoose;

export interface TenantDocument extends Document {
  _id: string;
  name: string;
  status: 'active' | 'suspended' | 'trial' | 'deleted';
  planId?: string;
  region?: string;
  allowedOrigins?: string[];
  cookieDomain?: string;
  jwtAudience?: string;
  jwtIssuer?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const tenantSchema = new Schema<TenantDocument>({
  _id: { type: String, required: true },
  name: { type: String, required: true, maxlength: 256 },
  status: { type: String, enum: ['active', 'suspended', 'trial', 'deleted'], default: 'active' },
  planId: { type: String },
  region: { type: String, default: 'eu' },
  allowedOrigins: { type: [String], default: [] },
  cookieDomain: { type: String },
  jwtAudience: { type: String },
  jwtIssuer: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

tenantSchema.index({ status: 1 });

export function getTenantModel(connection: Connection): Model<TenantDocument> {
  return (connection.models.Tenant as Model<TenantDocument>) ??
    connection.model<TenantDocument>('Tenant', tenantSchema);
}

export const Tenant: Model<TenantDocument> =
  (mongoose.models.Tenant as Model<TenantDocument>) ??
  mongoose.model<TenantDocument>('Tenant', tenantSchema);
