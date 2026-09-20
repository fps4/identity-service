/**
 * Assignments (ADR-0019/0020): `realm#assignment` / `<userId>#<applicationId>` — the pair is the key,
 * which is its uniqueness. A user's assignments are the key prefix; an application's members are
 * `gsi1` (`realm#assignment#application#<applicationId>` / `<userId>`).
 */
import type { AssignmentDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { count, getItem, queryAll, type Db } from './ops.js';
import type { Transaction } from './transaction.js';

const KIND = 'assignment';
export const assignmentKey = (userId: string, applicationId: string): Key => realm(KIND, `${userId}#${applicationId}`);
const byApplication = (applicationId: string): string => `${realmPartition(KIND)}#application#${applicationId}`;

export function assignments(db: Db) {
  return {
    get: (userId: string, applicationId: string) => getItem<AssignmentDocument>(db, assignmentKey(userId, applicationId)),

    /** The user's active entitlement to the application, or null if none or suspended. */
    async getActive(userId: string, applicationId: string): Promise<AssignmentDocument | null> {
      const found = await getItem<AssignmentDocument>(db, assignmentKey(userId, applicationId));
      return found && found.status === 'active' ? found : null;
    },

    listByUser: (userId: string) => queryAll<AssignmentDocument>(db, {
      keyCondition: '#pk = :pk AND begins_with(#sk, :prefix)',
      values: { ':pk': realmPartition(KIND), ':prefix': `${userId}#` }
    }),

    listByApplication: (applicationId: string) => queryAll<AssignmentDocument>(db, {
      index: 'gsi1', keyCondition: '#pk = :pk', values: { ':pk': byApplication(applicationId) }
    }),

    countActive: () => count(db, {
      keyCondition: '#pk = :pk', filter: '#status = :active',
      names: { '#status': 'status' }, values: { ':pk': realmPartition(KIND), ':active': 'active' }
    }),

    /** Write the assignment as given, inside the act's transaction (an upsert: the caller carries `createdAt` over). */
    put(tx: Transaction, doc: AssignmentDocument): void {
      tx.put({
        ...assignmentKey(doc.userId, doc.applicationId),
        kind: KIND,
        gsi1pk: byApplication(doc.applicationId),
        gsi1sk: doc.userId,
        ...(toAttributes(doc) as object)
      }, { label: 'assignment' });
    },

    delete(tx: Transaction, userId: string, applicationId: string): void {
      tx.delete(assignmentKey(userId, applicationId), { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'assignment' });
    }
  };
}
