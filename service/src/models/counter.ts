/**
 * Monotonic counters for the outbox (ADR-0022): `outbox` is the workspace's event sequence;
 * `subject#<principal id>` is the per-subject sequence. Both are advanced inside the emitting
 * transaction, on the condition that they have not moved since they were read (ADR-0023 §3), so the
 * order of the record is decided where the change is made and never by when a relay happened to read it.
 *
 * Stored as `ws#<workspace_id>#counter` / `<name>`.
 */
export interface CounterDocument {
  _id: string;
  value: number;
}
