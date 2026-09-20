/**
 * Issued tokens: `realm#oauth_token` / `<jti or refresh id>`. A refresh token is found by the hash of its
 * value through `gsi1` (`realm#oauth_token#refresh` / `<hash>`), then re-read from the table so a
 * revocation a moment ago is seen. `gsi2` orders tokens by issue time per type
 * (`realm#oauth_token#<type>` / `<issuedAt>`): the rate limit's and the console's counts. The table's
 * TTL removes a token a day after it expired, so the console's day of issuance stays countable.
 */
import type { OAuthTokenDocument } from '../models/index.js';
import { epochSeconds, toAttributes } from './codec.js';
import { realm, realmPartition, type Key } from './keys.js';
import { count, getItem, putItem, queryAll, updateItem, type Db } from './ops.js';

const KIND = 'oauth_token';
export const tokenKey = (id: string): Key => realm(KIND, id);
const byType = (type: OAuthTokenDocument['type']): string => `${realmPartition(KIND)}#${type}`;
const REFRESH_BY_HASH = `${realmPartition(KIND)}#refresh`;
const RETAIN_MS = 24 * 60 * 60 * 1000;

export function tokens(db: Db) {
  return {
    get: (id: string) => getItem<OAuthTokenDocument>(db, tokenKey(id)),

    async create(doc: OAuthTokenDocument): Promise<void> {
      await putItem(db, {
        ...tokenKey(doc._id),
        kind: KIND,
        ...(doc.type === 'refresh' && doc.hashedToken ? { gsi1pk: REFRESH_BY_HASH, gsi1sk: doc.hashedToken } : {}),
        gsi2pk: byType(doc.type),
        gsi2sk: doc.issuedAt.toISOString(),
        expires_at: epochSeconds(new Date(doc.expiresAt.getTime() + RETAIN_MS)),
        ...(toAttributes(doc) as object)
      }, { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: 'token' });
    },

    /** The refresh token behind a presented value's hash, as it is now. */
    async getRefreshByHash(hashedToken: string): Promise<OAuthTokenDocument | null> {
      const [found] = await queryAll<OAuthTokenDocument>(db, {
        index: 'gsi1', keyCondition: '#pk = :pk AND #sk = :hash', limit: 1,
        values: { ':pk': REFRESH_BY_HASH, ':hash': hashedToken }
      });
      return found ? getItem<OAuthTokenDocument>(db, tokenKey(found._id)) : null;
    },

    setStatus: (id: string, status: OAuthTokenDocument['status']) => updateItem<OAuthTokenDocument>(db, tokenKey(id), { set: { status } }),

    /** Tokens of a type issued since a moment — the rate limit and the console's hour/day. */
    countIssuedSince: (type: OAuthTokenDocument['type'], since: Date) => count(db, {
      index: 'gsi2', keyCondition: '#pk = :pk AND #sk >= :since',
      values: { ':pk': byType(type), ':since': since.toISOString() }
    }),

    countActiveRefresh: () => count(db, {
      index: 'gsi2', keyCondition: '#pk = :pk', filter: '#status = :active',
      names: { '#status': 'status' }, values: { ':pk': byType('refresh'), ':active': 'active' }
    })
  };
}
