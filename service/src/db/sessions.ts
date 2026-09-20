/** Sessions: `realm#session` / `<id>`; the table's TTL removes one at `expiresAt`. */
import type { SessionDocument } from '../models/index.js';
import { epochSeconds, toAttributes } from './codec.js';
import { realm, type Key } from './keys.js';
import { getItem, putItem, updateItem, type Db } from './ops.js';

const KIND = 'session';
export const sessionKey = (id: string): Key => realm(KIND, id);

export function sessions(db: Db) {
  return {
    get: (id: string) => getItem<SessionDocument>(db, sessionKey(id)),

    create: (doc: SessionDocument) => putItem(db, {
      ...sessionKey(doc._id), kind: KIND, expires_at: epochSeconds(doc.expiresAt), ...(toAttributes(doc) as object)
    }, { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'session' }),

    /** Set fields on an existing session; null if there is none. */
    update: (id: string, set: Partial<Omit<SessionDocument, '_id'>>) =>
      updateItem<SessionDocument>(db, sessionKey(id), { set: toAttributes(set) as Record<string, unknown> })
  };
}
