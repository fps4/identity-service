import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryArchive, InProcessDelivery, uuidv7, type SpineEvent } from '@fps4/maestro-spine';
import { createRelay, withRecordTransaction } from '../src/record/index.js';
import { ConditionFailed, Transaction, type Store } from '../src/db/index.js';
import { testStore, type TestStore } from './helpers/store.js';

/**
 * The relay never skips (ADR-0022 §5, maestro spine): an event the append rules refuse stops its
 * workspace where it stands, stays undelivered, and is named in the report. And the transaction helper
 * commits an act as one, retries it when the record's sequence moved, and hands the caller its own
 * failed condition (ADR-0023 §3).
 */

let db: TestStore;
let store: Store;

beforeAll(async () => {
  db = await testStore();
  store = db.store;
});
afterAll(() => db.drop());

const envelope = (seq: number, overrides: Record<string, unknown> = {}): SpineEvent => ({
  event_id: uuidv7(), workspace_id: 'ws-identity-test', seq,
  subject_type: 'principal', subject_id: 'prn-h-subject', subject_seq: seq, type: 'PrincipalSuspended', type_version: 1,
  occurred_at: '2026-09-20T00:00:00Z', recorded_at: '2026-09-20T00:00:00.000Z',
  accountable: 'prn-h-operator', acting: 'prn-h-operator', seat: 'operator', oversight_level: 'O0', consequence_class: 'c1',
  causation_id: null, correlation_id: uuidv7(), body: { reason: 'disabled' }, ...overrides
} as SpineEvent);

/** Put envelopes straight into the outbox, undelivered, as an act would have. */
async function stage(events: SpineEvent[]): Promise<void> {
  const tx = new Transaction();
  for (const event of events) store.outbox.put(tx, event);
  await store.commit(tx);
}

describe('the relay refuses what the spine would', () => {
  it('an agent in accountable stops the workspace at that seq; what came before is archived, nothing after is', async () => {
    const now = new Date();
    const tx = new Transaction();
    store.principals.register(tx, { _id: 'prn-h-operator', kind: 'human', status: 'active', subjectType: 'user', subjectId: 'u1', createdAt: now, updatedAt: now });
    store.principals.register(tx, { _id: 'prn-a-runner', kind: 'agent', status: 'active', subjectType: 'client', subjectId: 'c1', createdAt: now, updatedAt: now });
    await store.commit(tx);
    await stage([1, 2, 3].map((seq) => envelope(seq, seq === 2 ? { accountable: 'prn-a-runner', acting: 'prn-a-runner' } : {})));
    const relay = createRelay(async () => store, { archive: new MemoryArchive(), delivery: new InProcessDelivery() });
    const report = await relay.drain();
    expect(report.acked).toBe(1);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]).toMatchObject({ workspace_id: 'ws-identity-test', seq: 2 });
    expect(report.refused[0].issues[0].field).toBe('accountable');
    expect((await store.outbox.list()).map((r) => r.delivered)).toEqual([true, false, false]);
    // The refused event and what follows stay pending: the sparse index still lists them, in order.
    expect((await store.outbox.pending(10)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('a principal the registry does not know is unresolvable, and the event naming it waits', async () => {
    const other = await testStore();
    try {
      const tx = new Transaction();
      other.store.outbox.put(tx, envelope(1));
      await other.store.commit(tx);
      const relay = createRelay(async () => other.store, { archive: new MemoryArchive(), delivery: new InProcessDelivery() });
      const report = await relay.once();
      expect(report.acked).toBe(0);
      expect(report.refused[0].issues[0].message).toMatch(/must resolve to a known principal/);
    } finally {
      await other.drop();
    }
  });
});

describe('withRecordTransaction', () => {
  it('commits the act\'s writes as one transaction and returns what the act returned', async () => {
    const result = await withRecordTransaction(store, async (tx) => {
      store.counters.advance(tx, 'demo', await store.counters.read('demo'), 1);
      // The act reads what it needs and adds its writes; nothing is written until the commit.
      expect(await store.counters.read('demo')).toBe(0);
      return 42;
    });
    expect(result).toBe(42);
    expect(await store.counters.read('demo')).toBe(1);
  });

  it('retries from its reads when the record\'s counter moved under it, and each act lands once', async () => {
    const attempts: number[] = [];
    let first = true;
    await withRecordTransaction(store, async (tx) => {
      const seen = await store.counters.read('demo');
      attempts.push(seen);
      // Another act commits between this act's read and its commit — once.
      if (first) {
        first = false;
        const other = new Transaction();
        store.counters.advance(other, 'demo', seen, 1);
        await store.commit(other);
      }
      store.counters.advance(tx, 'demo', seen, 1);
    });
    expect(attempts).toEqual([1, 2]); // read 1, lost to the other act, read 2, committed 3
    expect(await store.counters.read('demo')).toBe(3);
  });

  it('hands the caller its own failed condition without retrying it', async () => {
    let runs = 0;
    await expect(withRecordTransaction(store, async (tx) => {
      runs++;
      tx.put({ pk: 'realm#demo', sk: 'one', kind: 'demo' }, { label: 'demo' });
      tx.put({ pk: 'realm#demo', sk: 'two', kind: 'demo' }, { condition: 'attribute_exists(#pk)', names: { '#pk': 'pk' }, label: 'demo' });
    })).rejects.toBeInstanceOf(ConditionFailed);
    expect(runs).toBe(1);
  });

  it('does not swallow an ordinary failure inside the transaction', async () => {
    await expect(withRecordTransaction(store, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
