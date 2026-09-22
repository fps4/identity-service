/**
 * Set-password links: `realm#password_link` / `<digest>` — one item per link, the SHA-256 digest of a
 * show-once token as its key (findable by value, like an invite's code — ADR-0013), the user it is
 * for, and its expiry, which is also the table's TTL. Redeeming a link deletes the item inside the
 * password's own transaction, on the condition that it is still there and still valid: two
 * redemptions racing cannot both pass, and a refused password hands the link back by never taking it.
 */
import { epochSeconds, toAttributes } from './codec.js';
import { realm, type Key } from './keys.js';
import { getItem, type Db } from './ops.js';
import type { Transaction } from './transaction.js';

const KIND = 'password_link';
export const passwordLinkKey = (digest: string): Key => realm(KIND, digest);

export interface PasswordLinkDocument {
  _id: string;          // the token's digest
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  createdBy?: string;   // the operator: an admin subject, a CLI user, the seed
}

export function passwordLinks(db: Db) {
  return {
    get: (digest: string) => getItem<PasswordLinkDocument>(db, passwordLinkKey(digest)),

    /** Issue: written once; a second link for the same user is simply a second item. */
    create(tx: Transaction, doc: PasswordLinkDocument): void {
      tx.put(
        { ...passwordLinkKey(doc._id), kind: KIND, expires_at: epochSeconds(doc.expiresAt), ...(toAttributes(doc) as object) },
        { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'password_link' }
      );
    },

    /** Redeem: gone with the password it set, and only if it was still there and still valid. */
    consume(tx: Transaction, digest: string, now: Date): void {
      tx.delete(passwordLinkKey(digest), {
        condition: 'attribute_exists(#pk) AND #expiresAt > :now',
        names: { '#pk': 'pk', '#expiresAt': 'expiresAt' },
        values: { ':now': now.toISOString() },
        label: 'password_link'
      });
    }
  };
}
