/**
 * An append-only record of a management-plane action (ADR-0007). Every authenticated /admin call is
 * logged with the acting principal (the client-credentials `cid`/`sub`), the action, the target, and
 * the resulting HTTP status — the per-actor accountability ADR-0003 said a static shared secret could
 * not provide. Never updated or deleted in normal operation.
 *
 * `_id` is a UUIDv7, so the key (`realm#audit_log` / `<_id>`, ADR-0023) sorts by time and the console's
 * "latest first" is a reverse key query.
 */
export interface AuditLogDocument {
  _id: string;
  at: Date;
  principalClientId?: string;  // token `cid`
  principalSubject?: string;   // token `sub`
  action: string;              // e.g. 'client.rotateSecret', 'user.create', 'invite.create'
  method: string;
  path: string;
  targetType?: string;         // 'client' | 'user' | 'key' | 'invite'
  targetId?: string;
  status: number;              // HTTP status the request resolved to
  meta?: Record<string, unknown>;
}
