import type { Connection, Model } from 'mongoose';
import type { Logger } from '../utils/logger.js';
import type {
  TenantDocument,
  OAuthClientDocument,
  OAuthTokenDocument,
  KeyStoreDocument,
  SessionDocument
} from '../models/index.js';

export interface ModelsBucket {
  Tenant: Model<TenantDocument>;
  OAuthClient: Model<OAuthClientDocument>;
  OAuthToken: Model<OAuthTokenDocument>;
  KeyStore: Model<KeyStoreDocument>;
  Session: Model<SessionDocument>;
}

export interface OAuthServerDependencies {
  getMasterConnection: () => Promise<Connection>;
  makeModels: (connection: Connection) => ModelsBucket;
  now?: () => Date;
  logger?: Logger;
}

export interface ClientCredentialsInput {
  clientId: string;
  clientSecret: string;
  scope?: string[];
  tenantId?: string;
  subject?: string;
  sessionId?: string;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string[];
}
