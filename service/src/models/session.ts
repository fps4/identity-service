/**
 * A session: the absolute lifetime a user's refresh tokens are bounded by (RQ-0001), or a legacy
 * `/v1/sessions` session. Stored as `realm#session` / `<_id>`; the table's TTL removes it at `expiresAt`.
 */
export interface SessionDocument {
  _id: string;
  visitorId?: string | null;
  contactId?: string | null;
  context?: Record<string, unknown> | null;
  status: 'active' | 'revoked';
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
