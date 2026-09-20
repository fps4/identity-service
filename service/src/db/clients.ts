/**
 * Credentials — OAuth clients under an application (ADR-0020): `realm#oauth_client` / `<client_id>`;
 * `gsi1` lists them per application (`realm#oauth_client#application#<applicationId>` / `<client_id>`).
 */
import type { OAuthClientDocument } from '../models/index.js';
import { toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { count, getItem, putItem, queryAll, updateItem, type Db } from './ops.js';
import { upsertExpression, type Transaction } from './transaction.js';

const KIND = 'oauth_client';
export const clientKey = (id: string): Key => realm(KIND, id);
const byApplication = (applicationId: string): string => `${realmPartition(KIND)}#application#${applicationId}`;

/** What a listing returns: never the secret hash. */
export type PublicClient = Omit<OAuthClientDocument, 'secretHash'>;

const withoutSecret = ({ secretHash: _secretHash, ...rest }: OAuthClientDocument): PublicClient => rest;

export function clients(db: Db) {
  const item = (doc: OAuthClientDocument) => ({
    ...clientKey(doc._id),
    kind: KIND,
    gsi1pk: byApplication(doc.applicationId),
    gsi1sk: doc._id,
    ...(toAttributes(doc) as object)
  });

  return {
    get: (id: string) => getItem<OAuthClientDocument>(db, clientKey(id)),

    /** All credentials, or one application's; without the secret hash. */
    async list(applicationId?: string): Promise<PublicClient[]> {
      const rows = applicationId
        ? await queryAll<OAuthClientDocument>(db, { index: 'gsi1', keyCondition: '#pk = :pk', values: { ':pk': byApplication(applicationId) } })
        : await queryAll<OAuthClientDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } });
      return rows.map(withoutSecret);
    },

    count: () => count(db, { keyCondition: '#pk = :pk', values: { ':pk': realmPartition(KIND) } }),

    countByApplication: (applicationId: string) =>
      count(db, { index: 'gsi1', keyCondition: '#pk = :pk', values: { ':pk': byApplication(applicationId) } }),

    /** Insert inside the act's transaction; the id must be free (`ConditionFailed('client')`). */
    put(tx: Transaction, doc: OAuthClientDocument): void {
      tx.put(item(doc), { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'client' });
    },

    /** Insert on its own. */
    create: (doc: OAuthClientDocument) =>
      putItem(db, item(doc), { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'client' }),

    update: (id: string, set: Partial<OAuthClientDocument>) => updateItem<OAuthClientDocument>(db, clientKey(id), { set }),

    /** The lazy backfill (ADR-0022): set the principal id only where there is none yet. */
    setPrincipalIdIfAbsent: (id: string, principalId: string, now = new Date()) =>
      updateItem<OAuthClientDocument>(db, clientKey(id), { set: { principalId, updatedAt: now } }, {
        condition: 'attribute_exists(#pk) AND attribute_not_exists(#principalId)',
        names: { '#principalId': 'principalId' }
      }),

    /**
     * The seed's reconcile (ADR-0021), inside the seed's transaction: structure replaced every run; the
     * secret hash and the principal id written on insert only, so a re-seed never reverts a rotation or
     * re-mints an id.
     */
    upsert(tx: Transaction, id: string, structure: Record<string, unknown>, onInsert: Record<string, unknown>, now = new Date()): void {
      const set = toAttributes({
        kind: KIND, _id: id, gsi1pk: byApplication(String(structure.applicationId)), gsi1sk: id, ...structure, updatedAt: now
      }) as Record<string, unknown>;
      // `toAttributes` drops undefined; an undefined field of the structure is to be removed.
      for (const [k, v] of Object.entries(structure)) if (v === undefined) set[k] = undefined;
      const expr = upsertExpression(set, { createdAt: now.toISOString(), ...(toAttributes(onInsert) as Record<string, unknown>) });
      tx.updateRaw(clientKey(id), expr.UpdateExpression, { names: expr.ExpressionAttributeNames, values: expr.ExpressionAttributeValues, label: 'client' });
    },

    delete(tx: Transaction, id: string): void {
      tx.delete(clientKey(id), { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'client' });
    }
  };
}
