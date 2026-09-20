/**
 * Registration invites (RQ-0013): `realm#invite` / `<id>`; the code digest is unique through
 * `realm#unique#invite_code` / `<digest>` → the id, written in the invite's transaction and the
 * redemption's lookup. Listed by the partition, newest first. An invite is never expired away by
 * the table: the console lists it as expired.
 */
import type { InviteDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, unique, uniqueItem, type Key } from './keys.js';
import { commit, getItem, queryAll, updateItem, type Db } from './ops.js';
import { Transaction } from './transaction.js';

const KIND = 'invite';
export const inviteKey = (id: string): Key => realm(KIND, id);
const digestKey = (digest: string): Key => unique('invite_code', digest);

const NOT_EXISTS = { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' } };

export function invites(db: Db) {
  return {
    get: (id: string) => getItem<InviteDocument>(db, inviteKey(id)),

    async getByDigest(digest: string): Promise<InviteDocument | null> {
      const ref = await getItem<{ ref: string }>(db, digestKey(digest));
      return ref ? getItem<InviteDocument>(db, inviteKey(ref.ref)) : null;
    },

    async create(doc: InviteDocument): Promise<void> {
      const tx = new Transaction();
      tx.put({ ...inviteKey(doc._id), kind: KIND, ...(toAttributes(doc) as object) }, { ...NOT_EXISTS, label: 'invite' });
      tx.put(uniqueItem(digestKey(doc.codeDigest), doc._id), { ...NOT_EXISTS, label: 'invite_code' });
      await commit(db, tx);
    },

    async list(): Promise<InviteDocument[]> {
      const rows = await queryAll<InviteDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } });
      return rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    },

    revoke: (id: string, now: Date) => updateItem<InviteDocument>(db, inviteKey(id), { set: { revokedAt: now, updatedAt: now } }),

    /**
     * Claim one use inside the registration's transaction (ADR-0013): a single conditional decrement,
     * so two registrations racing the last use cannot both pass, and a registration refused later in the
     * same transaction hands the use back by never taking it.
     */
    redeem(tx: Transaction, id: string, now: Date): void {
      tx.updateRaw(inviteKey(id), 'SET #usesRemaining = #usesRemaining - :one, #updatedAt = :now', {
        condition: 'attribute_exists(#pk) AND #usesRemaining > :zero AND #expiresAt > :nowIso AND (attribute_not_exists(#revokedAt) OR #revokedAt = :null)',
        names: { '#pk': 'pk', '#usesRemaining': 'usesRemaining', '#updatedAt': 'updatedAt', '#expiresAt': 'expiresAt', '#revokedAt': 'revokedAt' },
        values: { ':one': 1, ':zero': 0, ':now': now.toISOString(), ':nowIso': now.toISOString(), ':null': null },
        label: 'invite'
      });
    }
  };
}
