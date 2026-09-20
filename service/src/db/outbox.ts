/**
 * The transactional outbox (ADR-0022 §5): `ws#<workspace_id>#outbox` / `<seq, zero-padded>` — the
 * sequence is the key, so two acts allocated the same `seq` cannot both commit. An undelivered item also
 * carries `pending_pk`/`pending_sk` (the same partition, the same padded `seq`): the sparse `pending`
 * index the relay reads oldest-first. Acknowledging removes them; the item stays as the delivered row.
 */
import type { SpineEvent } from '@fps4/maestro-spine';
import type { OutboxDocument } from '../models/index.js';
import { padSeq } from './codec.js';
import { ws, wsPartition, type Key } from './keys.js';
import { queryAll, queryRaw, updateRawItem, type Db } from './ops.js';
import { RECORD_LABEL, type Transaction } from './transaction.js';

const KIND = 'outbox';

/** The relay's bookkeeping, never part of the event. */
const BOOKKEEPING = ['delivered', 'delivered_at', 'attempts'] as const;

export function outbox(db: Db) {
  const key = (seq: number): Key => ws(db.workspaceId, KIND, padSeq(seq));
  const partition = wsPartition(db.workspaceId, KIND);

  return {
    /** Put an envelope inside the act's transaction, undelivered. Its `seq` must be free. */
    put(tx: Transaction, event: SpineEvent): void {
      tx.put({
        ...key(event.seq),
        kind: KIND,
        pending_pk: partition,
        pending_sk: padSeq(event.seq),
        ...event,
        delivered: false,
        attempts: 0
      }, { condition: 'attribute_not_exists(#pk)', names: { '#pk': 'pk' }, label: `${RECORD_LABEL}outbox` });
    },

    /** Undelivered envelopes, oldest first, at most `limit` — what the relay carries. */
    async pending(limit: number): Promise<SpineEvent[]> {
      const rows = await queryRaw(db, { index: 'pending', keyCondition: '#pk = :pk', values: { ':pk': partition }, limit });
      return rows.map(envelopeOf);
    },

    /** Mark delivered: the bookkeeping set, the attempt counted, the pending keys removed. */
    async ack(events: readonly SpineEvent[], now = new Date()): Promise<void> {
      const at = now.toISOString();
      for (let i = 0; i < events.length; i += 25) {
        await Promise.all(events.slice(i, i + 25).map((event) =>
          updateRawItem(db, key(event.seq),
            'SET #delivered = :true, #delivered_at = :at, #attempts = if_not_exists(#attempts, :zero) + :one REMOVE #pending_pk, #pending_sk',
            {
              condition: 'attribute_exists(#pk)',
              names: { '#pk': 'pk', '#delivered': 'delivered', '#delivered_at': 'delivered_at', '#attempts': 'attempts', '#pending_pk': 'pending_pk', '#pending_sk': 'pending_sk' },
              values: { ':true': true, ':at': at, ':zero': 0, ':one': 1 }
            })
        ));
      }
    },

    /** Every row of the workspace, in sequence order, bookkeeping included — for tests and operators. */
    list: () => queryAll<OutboxDocument>(db, { keyCondition: '#pk = :pk', values: { ':pk': partition } })
  };
}

function envelopeOf(row: Record<string, unknown>): SpineEvent {
  const event: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'pk' || k === 'sk' || k === 'kind' || k === 'pending_pk' || k === 'pending_sk') continue;
    if ((BOOKKEEPING as readonly string[]).includes(k)) continue;
    event[k] = v;
  }
  return event as unknown as SpineEvent;
}
