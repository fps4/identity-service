/**
 * The RS256 signing keys (`utils/key-store.ts`): `realm#key_store` / `<kid>` — the kid is the key, which
 * is its uniqueness. Few items, ever: the partition is read whole and filtered in code.
 */
import type { KeyStoreDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { commit, putItem, queryAll, type Db } from './ops.js';
import { Transaction } from './transaction.js';

const KIND = 'key_store';
export const signingKeyKey = (kid: string): Key => realm(KIND, kid);

export function signingKeys(db: Db) {
  const all = () => queryAll<KeyStoreDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } });
  const item = (doc: KeyStoreDocument) => ({ ...signingKeyKey(doc.kid), kind: KIND, ...(toAttributes(doc) as object) });

  return {
    /** The newest active key, or null before the first was made. */
    async getActive(): Promise<KeyStoreDocument | null> {
      const active = (await all()).filter((k) => k.status === 'active');
      active.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
      return active[0] ?? null;
    },

    /** Active and inactive keys — what the JWKS publishes, so a token signed by a demoted key still verifies. */
    async listPublishable(): Promise<KeyStoreDocument[]> {
      return (await all()).filter((k) => k.status === 'active' || k.status === 'inactive');
    },

    async countActive(): Promise<number> {
      return (await all()).filter((k) => k.status === 'active').length;
    },

    /** Insert the first key; `ConditionFailed('key')` if the kid exists. */
    create: (doc: KeyStoreDocument) => putItem(db, item(doc), { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'key' }),

    /** Demote every active key and insert the new one, as one transaction. */
    async rotate(activeKids: string[], doc: KeyStoreDocument, now: Date): Promise<void> {
      const tx = new Transaction();
      for (const kid of activeKids) tx.update(signingKeyKey(kid), { set: { status: 'inactive', rotatedAt: now } }, { label: 'key' });
      tx.put(item(doc), { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'key' });
      await commit(db, tx);
    }
  };
}
