import mongoose, { Connection, Document, Model } from 'mongoose';

export interface KeyStoreDocument extends Document {
  kid: string;
  tenantId?: string | null;
  privateKey: string; // PEM, encrypted if configured
  publicKey: string; // PEM
  algorithm: 'RS256';
  status: 'active' | 'inactive' | 'retired';
  createdAt?: Date;
  rotatedAt?: Date | null;
}

const keyStoreSchema = new mongoose.Schema<KeyStoreDocument>({
  kid: { type: String, required: true, unique: true },
  tenantId: { type: String, default: null, index: true },
  privateKey: { type: String, required: true },
  publicKey: { type: String, required: true },
  algorithm: { type: String, enum: ['RS256'], default: 'RS256' },
  status: { type: String, enum: ['active', 'inactive', 'retired'], default: 'active', index: true },
  createdAt: { type: Date, default: Date.now },
  rotatedAt: { type: Date, default: null }
});

export function getKeyStoreModel(connection: Connection): Model<KeyStoreDocument> {
  return (connection.models.KeyStore as Model<KeyStoreDocument>) ??
    connection.model<KeyStoreDocument>('KeyStore', keyStoreSchema, 'key_store');
}

export const KeyStore: Model<KeyStoreDocument> =
  (mongoose.models.KeyStore as Model<KeyStoreDocument>) ??
  mongoose.model<KeyStoreDocument>('KeyStore', keyStoreSchema, 'key_store');
