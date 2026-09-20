import type { Connection, Model } from 'mongoose';
import { getSessionModel, Session, type SessionDocument } from './session.js';
import { getOAuthClientModel, OAuthClient, type OAuthClientDocument } from './oauth-client.js';
import { getOAuthTokenModel, OAuthToken, type OAuthTokenDocument } from './oauth-token.js';
import { getOAuthAuthorizationModel, OAuthAuthorization, type OAuthAuthorizationDocument } from './oauth-authorization.js';
import { getUserModel, User, type UserDocument } from './user.js';
import { getInviteModel, Invite, type InviteDocument } from './invite.js';
import { getAssignmentModel, Assignment, type AssignmentDocument } from './assignment.js';
import { getApplicationModel, Application, type ApplicationDocument } from './application.js';
import { getKeyStoreModel, KeyStore, type KeyStoreDocument } from './key-store.js';
import { getAuditLogModel, AuditLog, type AuditLogDocument } from './audit-log.js';
import { getPrincipalModel, Principal, type PrincipalDocument } from './principal.js';
import { getOutboxModel, Outbox, type OutboxDocument } from './outbox.js';
import { getCounterModel, Counter, type CounterDocument } from './counter.js';

export const makeModels = (connection: Connection) => ({
  Session: getSessionModel(connection) as Model<SessionDocument>,
  Application: getApplicationModel(connection) as Model<ApplicationDocument>,
  OAuthClient: getOAuthClientModel(connection) as Model<OAuthClientDocument>,
  OAuthToken: getOAuthTokenModel(connection) as Model<OAuthTokenDocument>,
  OAuthAuthorization: getOAuthAuthorizationModel(connection) as Model<OAuthAuthorizationDocument>,
  User: getUserModel(connection) as Model<UserDocument>,
  Invite: getInviteModel(connection) as Model<InviteDocument>,
  Assignment: getAssignmentModel(connection) as Model<AssignmentDocument>,
  KeyStore: getKeyStoreModel(connection) as Model<KeyStoreDocument>,
  AuditLog: getAuditLogModel(connection) as Model<AuditLogDocument>,
  // maestro's record (ADR-0022): the principal registry, the transactional outbox and its counters.
  Principal: getPrincipalModel(connection) as Model<PrincipalDocument>,
  Outbox: getOutboxModel(connection) as Model<OutboxDocument>,
  Counter: getCounterModel(connection) as Model<CounterDocument>
});

export { Session, type SessionDocument } from './session.js';
export { Application, type ApplicationDocument, type AppRole } from './application.js';
export { OAuthClient, type OAuthClientDocument } from './oauth-client.js';
export { OAuthToken, type OAuthTokenDocument } from './oauth-token.js';
export { OAuthAuthorization, type OAuthAuthorizationDocument } from './oauth-authorization.js';
export { User, type UserDocument, type FederatedIdentity } from './user.js';
export { Invite, type InviteDocument } from './invite.js';
export { Assignment, type AssignmentDocument } from './assignment.js';
export { KeyStore, type KeyStoreDocument } from './key-store.js';
// (Application re-exported above.)
export { AuditLog, type AuditLogDocument } from './audit-log.js';
export { Principal, type PrincipalDocument, type PrincipalKind, type PrincipalStatus } from './principal.js';
export { Outbox, type OutboxDocument } from './outbox.js';
export { Counter, type CounterDocument } from './counter.js';
