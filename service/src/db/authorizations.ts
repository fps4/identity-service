/**
 * In-flight logins (RQ-0001/0002): `realm#oauth_authorization` / `<id>`. The three handles the flow
 * presents — the Google `state`, the local form's `loginToken`, the minted `code` — each resolve
 * through a `unique` item (`realm#unique#authorization_state|_login|_code` / `<handle>` → the id)
 * written in the same transaction as the handle, so the exchange that follows a redirect within the
 * second reads its own write. Every item expires with the authorization (the table's TTL).
 */
import type { OAuthAuthorizationDocument } from '../models/index.js';
import { epochSeconds, toAttributes } from './codec.js';
import { realm, realmPartition, unique, uniqueItem, type Key } from './keys.js';
import { commit, count, getItem, updateItem, type Db } from './ops.js';
import { ConditionFailed, Transaction } from './transaction.js';

const KIND = 'oauth_authorization';
export const authorizationKey = (id: string): Key => realm(KIND, id);
const stateKey = (state: string): Key => unique('authorization_state', state);
const loginKey = (token: string): Key => unique('authorization_login', token);
const codeKey = (code: string): Key => unique('authorization_code', code);

const NOT_EXISTS = { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' } };

export function authorizations(db: Db) {
  async function byHandle(key: Key): Promise<OAuthAuthorizationDocument | null> {
    const ref = await getItem<{ ref: string }>(db, key);
    return ref ? getItem<OAuthAuthorizationDocument>(db, authorizationKey(ref.ref)) : null;
  }

  return {
    get: (id: string) => getItem<OAuthAuthorizationDocument>(db, authorizationKey(id)),

    /** In-flight logins, whatever their state, until the TTL sweeps them. */
    count: () => count(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } }),

    async create(doc: OAuthAuthorizationDocument): Promise<void> {
      const ttl = epochSeconds(doc.expiresAt);
      const tx = new Transaction();
      tx.put({ ...authorizationKey(doc._id), kind: KIND, expires_at: ttl, ...(toAttributes(doc) as object) }, { ...NOT_EXISTS, label: 'authorization' });
      tx.put(uniqueItem(stateKey(doc.googleState), doc._id, ttl), { ...NOT_EXISTS, label: 'authorization_state' });
      if (doc.loginToken) tx.put(uniqueItem(loginKey(doc.loginToken), doc._id, ttl), { ...NOT_EXISTS, label: 'authorization_login' });
      await commit(db, tx);
    },

    getByState: (state: string) => byHandle(stateKey(state)),
    getByLoginToken: (token: string) => byHandle(loginKey(token)),
    getByCode: (code: string) => byHandle(codeKey(code)),

    /**
     * The IdP established who this is: mint the code, drop the form handle. Conditioned on the login
     * still pending, so two submissions of one form cannot both authenticate it.
     */
    async authenticate(doc: OAuthAuthorizationDocument, identity: { code: string; email: string; sub: string; emailVerified: boolean }): Promise<boolean> {
      const tx = new Transaction();
      tx.update(authorizationKey(doc._id), {
        set: { status: 'authenticated', code: identity.code, email: identity.email, sub: identity.sub, emailVerified: identity.emailVerified },
        remove: ['loginToken']
      }, { condition: '#status = :pending', names: { '#status': 'status' }, values: { ':pending': 'pending' }, label: 'authorization' });
      tx.put(uniqueItem(codeKey(identity.code), doc._id, epochSeconds(doc.expiresAt)), { ...NOT_EXISTS, label: 'authorization_code' });
      try {
        await commit(db, tx);
        return true;
      } catch (err) {
        if (err instanceof ConditionFailed) return false;
        throw err;
      }
    },

    /** Consume the code: single-use, so a replay finds nothing to consume and mints nothing. */
    async consume(id: string): Promise<boolean> {
      const updated = await updateItem<OAuthAuthorizationDocument>(db, authorizationKey(id), { set: { status: 'consumed' }, remove: ['code'] }, {
        condition: '#status = :authenticated', names: { '#status': 'status' }, values: { ':authenticated': 'authenticated' }
      });
      return updated !== null;
    }
  };
}
