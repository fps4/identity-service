/**
 * The documents this service stores — the shapes the services, routes and scripts read and write. How
 * each is keyed in the table is `db/` (ADR-0023); the API returns them as they are here (`_id` and all).
 */
export type { SessionDocument } from './session.js';
export type { ApplicationDocument, AppRole } from './application.js';
export type { OAuthClientDocument } from './oauth-client.js';
export type { OAuthTokenDocument } from './oauth-token.js';
export type { OAuthAuthorizationDocument } from './oauth-authorization.js';
export type { UserDocument, FederatedIdentity } from './user.js';
export type { InviteDocument } from './invite.js';
export type { AssignmentDocument } from './assignment.js';
export type { KeyStoreDocument } from './key-store.js';
export type { AuditLogDocument } from './audit-log.js';
export type { PrincipalDocument, PrincipalKind, PrincipalStatus } from './principal.js';
export type { OutboxDocument } from './outbox.js';
export type { CounterDocument } from './counter.js';
