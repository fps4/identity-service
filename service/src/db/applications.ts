/** Applications (ADR-0020): `realm#application` / `<id>`. Listed and counted by the partition. */
import { randomUUID } from 'crypto';
import type { ApplicationDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { batchGet, count, getItem, putItem, queryAll, updateItem, updateRawItem, type Db } from './ops.js';
import { upsertExpression, type Transaction } from './transaction.js';

const KIND = 'application';
export const applicationKey = (id: string): Key => realm(KIND, id);

export function applications(db: Db) {
  const item = (doc: ApplicationDocument) => ({ ...applicationKey(doc._id), kind: KIND, ...(toAttributes(doc) as object) });

  return {
    get: (id: string) => getItem<ApplicationDocument>(db, applicationKey(id)),

    list: () => queryAll<ApplicationDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } }),

    getMany: (ids: string[]) => batchGet<ApplicationDocument>(db, [...new Set(ids)].map(applicationKey)),

    count: () => count(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } }),

    /** Insert; `ConditionFailed('application')` if the id is taken. */
    async create(input: Omit<ApplicationDocument, 'createdAt' | 'updatedAt' | '_id'> & { _id?: string }, now = new Date()): Promise<ApplicationDocument> {
      const doc: ApplicationDocument = { ...input, _id: input._id ?? randomUUID(), createdAt: now, updatedAt: now };
      await putItem(db, item(doc), { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'application' });
      return doc;
    },

    /** Set fields on an existing application; null if there is none. */
    update: (id: string, set: Partial<ApplicationDocument>) => updateItem<ApplicationDocument>(db, applicationKey(id), { set }),

    /** The seed's reconcile: structure replaced every run, `createdAt` kept from the first. */
    upsert(id: string, fields: Pick<ApplicationDocument, 'name' | 'audience' | 'roles' | 'resources'>, now = new Date()) {
      const set = toAttributes({ kind: KIND, _id: id, ...fields, updatedAt: now }) as Record<string, unknown>;
      const expr = upsertExpression({ ...set, audience: fields.audience }, { createdAt: now.toISOString() });
      return updateRawItem<ApplicationDocument>(db, applicationKey(id), expr.UpdateExpression, { names: expr.ExpressionAttributeNames, values: expr.ExpressionAttributeValues });
    },

    /** Delete inside the act's transaction; the application must still exist. */
    delete(tx: Transaction, id: string): void {
      tx.delete(applicationKey(id), { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'application' });
    }
  };
}
