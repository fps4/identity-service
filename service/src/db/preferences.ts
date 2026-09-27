/**
 * Preferences: `realm#preferences` / `<userId>#<applicationId>` — one item per person per application
 * (maestro ADR-0029). A write replaces the document; there is no history and nothing to record.
 */
import type { PreferencesDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, type Key } from './keys.js';
import { getItem, putItem, type Db } from './ops.js';

const KIND = 'preferences';
export const preferencesKey = (userId: string, applicationId: string): Key => realm(KIND, `${userId}#${applicationId}`);

export function preferences(db: Db) {
  return {
    get: (userId: string, applicationId: string) =>
      getItem<PreferencesDocument>(db, preferencesKey(userId, applicationId)),

    put: (doc: Omit<PreferencesDocument, '_id'>) => putItem(db, {
      ...preferencesKey(doc.userId, doc.applicationId),
      kind: KIND,
      ...(toAttributes({ _id: `${doc.userId}#${doc.applicationId}`, ...doc }) as object)
    })
  };
}
