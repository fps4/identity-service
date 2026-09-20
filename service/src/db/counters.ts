/**
 * The record's counters (ADR-0022): `ws#<workspace_id>#counter` / `outbox` is the workspace's sequence,
 * `/ subject#<prn>` a principal's. Read consistently before the act, advanced in its transaction on the
 * condition that nothing moved them meanwhile (ADR-0023 §3); a failed condition is retried from the
 * reads by `withRecordTransaction`.
 */
import { ws, type Key } from './keys.js';
import { getItem, type Db } from './ops.js';
import { RECORD_LABEL, type Transaction } from './transaction.js';

const KIND = 'counter';
export const OUTBOX_COUNTER = 'outbox';
export const subjectCounter = (principalId: string): string => `subject#${principalId}`;

export function counters(db: Db) {
  const key = (name: string): Key => ws(db.workspaceId, KIND, name);

  return {
    /** The counter's value now; 0 before it was ever advanced. */
    async read(name: string): Promise<number> {
      const row = await getItem<{ value?: number }>(db, key(name));
      return row?.value ?? 0;
    },

    /** Advance by `by` from the value read, inside the transaction; fails if it moved since. */
    advance(tx: Transaction, name: string, expected: number, by: number): void {
      tx.put({ ...key(name), kind: KIND, _id: name, value: expected + by }, {
        condition: expected === 0 ? 'attribute_not_exists(#pk)' : '#value = :expected',
        names: expected === 0 ? { '#pk': 'pk' } : { '#value': 'value' },
        ...(expected === 0 ? {} : { values: { ':expected': expected } }),
        label: `${RECORD_LABEL}counter`
      });
    }
  };
}
