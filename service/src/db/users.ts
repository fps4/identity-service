/**
 * The user pool (RQ-0002, RQ-0011): `realm#user` / `<id>`. The email is unique through
 * `realm#unique#email` / `<email>` → the user; each linked identity through `realm#unique#identity` /
 * `<provider>#<subject>` → the user. Both are written in the user's transaction and are how a login
 * finds the person (strongly consistent). `gsi2` orders users by `createdAt` for the registration
 * rate limit's "how many in the last minute".
 */
import type { FederatedIdentity, UserDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, unique, uniqueItem, type Key } from './keys.js';
import { batchGet, commit, count, getItem, queryAll, updateItem, type Db } from './ops.js';
import { Transaction } from './transaction.js';

const KIND = 'user';
export const userKey = (id: string): Key => realm(KIND, id);
const emailKey = (email: string): Key => unique('email', email);
const identityKey = (provider: string, subject: string): Key => unique('identity', `${provider}#${subject}`);

/** The upstream providers a subject may come from — what a `sub` lookup tries (RQ-0001: Google only). */
const PROVIDERS = ['google'] as const;

/** What a listing returns: never the password hash. */
export type PublicUser = Omit<UserDocument, 'passwordHash'>;

const NOT_EXISTS = { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' } };

export function users(db: Db) {
  const item = (doc: UserDocument) => {
    const createdAt = doc.createdAt ?? new Date();
    return {
      ...userKey(doc._id),
      kind: KIND,
      gsi2pk: realmPartition(KIND),
      gsi2sk: createdAt.toISOString(),
      ...(toAttributes({ ...doc, createdAt }) as object)
    };
  };

  async function byUnique(key: Key): Promise<UserDocument | null> {
    const ref = await getItem<{ ref: string }>(db, key);
    return ref ? getItem<UserDocument>(db, userKey(ref.ref)) : null;
  }

  return {
    get: (id: string) => getItem<UserDocument>(db, userKey(id)),

    getByEmail: (email: string) => byUnique(emailKey(email)),

    getByIdentity: (provider: string, subject: string) => byUnique(identityKey(provider, subject)),

    /** The person behind a token `sub`: a local login's is the user id, a federated login's the provider subject (ADR-0012). */
    async getBySubject(sub: string): Promise<UserDocument | null> {
      const local = await getItem<UserDocument>(db, userKey(sub));
      if (local) return local;
      for (const provider of PROVIDERS) {
        const linked = await byUnique(identityKey(provider, sub));
        if (linked) return linked;
      }
      return null;
    },

    async list(): Promise<PublicUser[]> {
      const rows = await queryAll<UserDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } });
      return rows.map(({ passwordHash: _passwordHash, ...rest }) => rest);
    },

    getMany: (ids: string[]) => batchGet<UserDocument>(db, [...new Set(ids)].map(userKey)),

    count: () => count(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } }),

    countLocked: (now: Date) => count(db, {
      keyCondition: '#pk = :pk', filter: '#lockedUntil > :now',
      names: { '#lockedUntil': 'lockedUntil' }, values: { ':pk': realmPartition(KIND), ':now': now.toISOString() }
    }),

    countByStatus: (status: UserDocument['status']) => count(db, {
      keyCondition: '#pk = :pk', filter: '#status = :status',
      names: { '#status': 'status' }, values: { ':pk': realmPartition(KIND), ':status': status }
    }),

    countCreatedSince: (since: Date) => count(db, {
      index: 'gsi2', keyCondition: '#pk = :pk AND #sk >= :since',
      values: { ':pk': realmPartition(KIND), ':since': since.toISOString() }
    }),

    /**
     * Insert inside the act's transaction, claiming the email and every linked identity. A taken email is
     * `ConditionFailed('email')`; a linked identity already on another user, `ConditionFailed('identity')`.
     */
    put(tx: Transaction, doc: UserDocument): void {
      tx.put(item(doc), { ...NOT_EXISTS, label: 'user' });
      tx.put(uniqueItem(emailKey(doc.email), doc._id), { ...NOT_EXISTS, label: 'email' });
      for (const identity of doc.identities ?? []) {
        tx.put(uniqueItem(identityKey(identity.provider, identity.subject), doc._id), { ...NOT_EXISTS, label: 'identity' });
      }
    },

    /** Set fields on an existing user; null if there is none. The email itself never changes. */
    update: (id: string, set: Partial<Omit<UserDocument, '_id' | 'email' | 'identities'>>) =>
      updateItem<UserDocument>(db, userKey(id), { set }),

    /** Set fields on an existing user inside the act's transaction. */
    updateIn(tx: Transaction, id: string, set: Partial<Omit<UserDocument, '_id' | 'email' | 'identities'>>): void {
      tx.update(userKey(id), { set }, { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'user' });
    },

    /** The lazy backfill (ADR-0022): set the principal id only where there is none yet. */
    setPrincipalIdIfAbsent: (id: string, principalId: string, now = new Date()) =>
      updateItem<UserDocument>(db, userKey(id), { set: { principalId, updatedAt: now } }, {
        condition: 'attribute_exists(#pk) AND attribute_not_exists(#principalId)',
        names: { '#principalId': 'principalId' }
      }),

    /**
     * Link an identity (RQ-0011): the identity claimed for this user (`ConditionFailed('identity')` if
     * another has it) and appended, as one transaction. `identities` is replaced from what the caller
     * read, so the write is conditioned on that read still being current.
     */
    async linkIdentity(user: UserDocument, identity: FederatedIdentity, now: Date): Promise<void> {
      const tx = new Transaction();
      tx.put(uniqueItem(identityKey(identity.provider, identity.subject), user._id), { ...NOT_EXISTS, label: 'identity' });
      tx.update(userKey(user._id), { set: { identities: toAttributes([...(user.identities ?? []), identity]), lastLoginAt: now, updatedAt: now } }, {
        condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'user'
      });
      await commit(db, tx);
    },

    /** Replace a user's identities with the given list (and set what else changed), releasing what was dropped. */
    async setIdentities(user: UserDocument, identities: FederatedIdentity[], now: Date, set: Partial<Pick<UserDocument, 'lastLoginAt'>> = {}): Promise<void> {
      const tx = new Transaction();
      const keep = new Set(identities.map((i) => `${i.provider}#${i.subject}`));
      for (const old of user.identities ?? []) {
        if (!keep.has(`${old.provider}#${old.subject}`)) tx.delete(identityKey(old.provider, old.subject));
      }
      tx.update(userKey(user._id), { set: { ...set, identities: toAttributes(identities), updatedAt: now } }, {
        condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'user'
      });
      await commit(db, tx);
    },

    /** Delete inside the act's transaction, releasing the email and every identity. */
    delete(tx: Transaction, user: Pick<UserDocument, '_id' | 'email' | 'identities'>): void {
      tx.delete(userKey(user._id), { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'user' });
      tx.delete(emailKey(user.email));
      for (const identity of user.identities ?? []) tx.delete(identityKey(identity.provider, identity.subject));
    }
  };
}
