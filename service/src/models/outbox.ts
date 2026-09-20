/**
 * The transactional outbox (ADR-0022): maestro's spine envelope, written in the same transaction as the
 * change it records, plus the relay's bookkeeping.
 *
 * The item IS the envelope. `emit()` builds it at the act, validates it with the spine's own rules and
 * puts it beside the change; the relay reads it, archives it unchanged and acknowledges it. Nothing
 * downstream joins a row to whatever the registry or the configuration say later — attribution is fixed
 * where the act happened, which is the only place it is known. The envelope's fields are the spine's
 * (`@fps4/maestro-spine`, `eventSchema`); the three bookkeeping fields are ours and are stripped before
 * an event leaves this service.
 *
 * Stored as `ws#<workspace_id>#outbox` / `<seq, zero-padded>` — the sequence is the key, so a double
 * allocation is a failed condition rather than a silent gap. While undelivered the item also carries
 * `pending_pk`/`pending_sk`, the sparse `pending` index the relay reads; delivery removes them (ADR-0023).
 */
export interface OutboxDocument {
  event_id: string;            // UUIDv7, minted at emit
  workspace_id: string;        // ws-… — this deployment's workspace on maestro's record
  seq: number;                 // monotonic per workspace, assigned in the emitting transaction
  subject_type: string;        // always `principal` here
  subject_id: string;          // the principal's maestro id
  subject_seq: number;         // per subject; optimistic concurrency for a projection
  type: string;
  type_version: number;
  occurred_at: string;
  recorded_at: string;
  accountable: string;         // a human principal — always
  acting: string;              // who performed the act — may be an agent or a workload
  seat: string;
  oversight_level: string;
  consequence_class: string;
  causation_id: string | null;
  correlation_id: string;
  body: Record<string, unknown>;
  payload_ref?: string;
  payload_digest?: string;
  // --- the relay's bookkeeping; never part of the event ---
  delivered: boolean;
  delivered_at?: string;
  attempts: number;
}
