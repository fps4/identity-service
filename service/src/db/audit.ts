/**
 * The append-only audit log (ADR-0007): `realm#audit_log` / `<id>`, the id a UUIDv7 so the key orders by
 * time and "the latest N" is one reverse query. Never updated or deleted by the service.
 */
import { uuidv7 } from '@fps4/maestro-spine';
import type { AuditLogDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { putItem, queryAll, type Db } from './ops.js';

const KIND = 'audit_log';
export const auditKey = (id: string): Key => realm(KIND, id);

export function audit(db: Db) {
  return {
    async create(entry: Omit<AuditLogDocument, '_id'> & { _id?: string }): Promise<AuditLogDocument> {
      const doc: AuditLogDocument = { ...entry, _id: entry._id ?? uuidv7() };
      await putItem(db, { ...auditKey(doc._id), kind: KIND, ...(toAttributes(doc) as object) });
      return doc;
    },

    latest: (limit: number) => queryAll<AuditLogDocument>(db, {
      keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) }, forward: false, limit
    })
  };
}
