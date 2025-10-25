import type { Connection, Model } from 'mongoose';
import { getTenantModel, Tenant, type TenantDocument } from './tenant.js';
import { getSessionModel, Session, type SessionDocument } from './session.js';

export const makeModels = (connection: Connection) => ({
  Tenant: getTenantModel(connection) as Model<TenantDocument>,
  Session: getSessionModel(connection) as Model<SessionDocument>
});

export { Tenant, type TenantDocument } from './tenant.js';
export { Session, type SessionDocument } from './session.js';
