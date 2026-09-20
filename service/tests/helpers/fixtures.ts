/**
 * Rows a test puts in its table before the act under test: the shapes `models/` declares, with the
 * defaults a service would have written, in one call each.
 */
import { Transaction, type Store } from '../../src/db/index.js';
import type {
  ApplicationDocument,
  AssignmentDocument,
  OAuthAuthorizationDocument,
  OAuthClientDocument,
  OAuthTokenDocument,
  SessionDocument,
  UserDocument
} from '../../src/models/index.js';

type With<T, K extends keyof T> = Partial<T> & Pick<T, K>;

const at = (now?: Date) => now ?? new Date();

export const fixtures = {
  async application(store: Store, doc: With<ApplicationDocument, '_id' | 'name'>, now?: Date): Promise<ApplicationDocument> {
    const { createdAt: _c, updatedAt: _u, ...rest } = doc;
    return store.applications.create({ roles: [], resources: [], ...rest }, at(now));
  },

  async client(store: Store, doc: With<OAuthClientDocument, '_id'>, now?: Date): Promise<OAuthClientDocument> {
    const full: OAuthClientDocument = {
      applicationId: 'app', name: doc._id, secretHash: '', grantTypes: [], redirectUris: [], scopes: [], isConfidential: false,
      createdAt: at(now), updatedAt: at(now), ...doc
    };
    await store.clients.create(full);
    return full;
  },

  async user(store: Store, doc: With<UserDocument, '_id' | 'email'>, now?: Date): Promise<UserDocument> {
    const full: UserDocument = {
      identities: [], emailVerified: false, status: 'active', failedAttempts: 0, lockedUntil: null,
      createdAt: at(now), updatedAt: at(now), ...doc
    };
    const tx = new Transaction();
    store.users.put(tx, full);
    await store.commit(tx);
    return full;
  },

  async assignment(store: Store, doc: With<AssignmentDocument, 'userId' | 'applicationId'>, now?: Date): Promise<AssignmentDocument> {
    const full: AssignmentDocument = { roles: [], status: 'active', createdAt: at(now), updatedAt: at(now), ...doc };
    const tx = new Transaction();
    store.assignments.put(tx, full);
    await store.commit(tx);
    return full;
  },

  async token(store: Store, doc: With<OAuthTokenDocument, '_id' | 'clientId' | 'type'>, now?: Date): Promise<OAuthTokenDocument> {
    const full: OAuthTokenDocument = {
      scope: [], status: 'active', issuedAt: at(now), expiresAt: new Date(at(now).getTime() + 900_000), ...doc
    };
    await store.tokens.create(full);
    return full;
  },

  async session(store: Store, doc: With<SessionDocument, '_id'>, now?: Date): Promise<SessionDocument> {
    const full: SessionDocument = {
      status: 'active', expiresAt: new Date(at(now).getTime() + 3_600_000), createdAt: at(now), updatedAt: at(now), ...doc
    };
    await store.sessions.create(full);
    return full;
  },

  async authorization(store: Store, doc: With<OAuthAuthorizationDocument, '_id' | 'clientId'>, now?: Date): Promise<OAuthAuthorizationDocument> {
    const full: OAuthAuthorizationDocument = {
      consumerRedirectUri: 'https://app.example.test/cb', codeChallenge: '', codeChallengeMethod: 'S256', scope: [], idp: 'google',
      googleState: `state-${doc._id}`, nonce: `nonce-${doc._id}`, status: 'pending', expiresAt: new Date(at(now).getTime() + 600_000),
      createdAt: at(now), ...doc
    };
    await store.authorizations.create(full);
    return full;
  }
};
