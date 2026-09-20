import { describe, it, expect } from 'vitest';
import { MemoryArchive, InProcessDelivery, uuidv7 } from '@fps4/maestro-spine';
import { createRelay, withRecordTransaction, resetTransactionProbe } from '../src/record/index.js';
import { fakeModels } from './helpers/fake-mongo.js';

/**
 * The relay never skips (ADR-0022 §5, maestro spine): an event the append rules refuse stops its
 * workspace where it stands, stays undelivered, and is named in the report. And the transaction helper
 * degrades honestly on a database that cannot transact.
 */

const envelope = (seq: number, overrides: Record<string, unknown> = {}) => ({
  _id: uuidv7(), event_id: undefined as unknown as string, workspace_id: 'ws-identity-test', seq,
  subject_type: 'principal', subject_id: 'prn-h-subject', subject_seq: seq, type: 'PrincipalSuspended', type_version: 1,
  occurred_at: '2026-09-20T00:00:00Z', recorded_at: '2026-09-20T00:00:00.000Z',
  accountable: 'prn-h-operator', acting: 'prn-h-operator', seat: 'operator', oversight_level: 'O0', consequence_class: 'c1',
  causation_id: null, correlation_id: uuidv7(), body: { reason: 'disabled' }, delivered: false, attempts: 0, ...overrides
});

describe('the relay refuses what the spine would', () => {
  it('an agent in accountable stops the workspace at that seq; what came before is archived, nothing after is', async () => {
    const state = fakeModels();
    state.Principal._items.push(
      { _id: 'prn-h-operator', kind: 'human', status: 'active', subjectType: 'user', subjectId: 'u1' },
      { _id: 'prn-a-runner', kind: 'agent', status: 'active', subjectType: 'client', subjectId: 'c1' }
    );
    for (const seq of [1, 2, 3]) {
      const row = envelope(seq, seq === 2 ? { accountable: 'prn-a-runner', acting: 'prn-a-runner' } : {});
      row.event_id = row._id;
      state.Outbox._items.push(row);
    }
    const relay = createRelay(async () => state as any, { archive: new MemoryArchive(), delivery: new InProcessDelivery() });
    const report = await relay.drain();
    expect(report.acked).toBe(1);
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]).toMatchObject({ workspace_id: 'ws-identity-test', seq: 2 });
    expect(report.refused[0].issues[0].field).toBe('accountable');
    expect(state.Outbox._items.map((r) => r.delivered)).toEqual([true, false, false]);
  });

  it('a principal the registry does not know is unresolvable, and the event naming it waits', async () => {
    const state = fakeModels();
    const row = envelope(1); row.event_id = row._id;
    state.Outbox._items.push(row);
    const relay = createRelay(async () => state as any, { archive: new MemoryArchive(), delivery: new InProcessDelivery() });
    const report = await relay.once();
    expect(report.acked).toBe(0);
    expect(report.refused[0].issues[0].message).toMatch(/must resolve to a known principal/);
  });
});

describe('withRecordTransaction', () => {
  it('runs inside a transaction where the database supports one', async () => {
    resetTransactionProbe();
    const calls: string[] = [];
    const connection = {
      startSession: async () => ({
        withTransaction: async (fn: () => Promise<void>) => { calls.push('begin'); await fn(); calls.push('commit'); },
        endSession: async () => { calls.push('end'); }
      })
    } as any;
    const result = await withRecordTransaction(connection, async (session) => { calls.push(session ? 'with-session' : 'no-session'); return 42; });
    expect(result).toBe(42);
    expect(calls).toEqual(['begin', 'with-session', 'commit', 'end']);
  });

  it('falls back to no session on a standalone server, once, and says so', async () => {
    resetTransactionProbe();
    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg), info: () => {} } as any;
    let attempts = 0;
    const connection = {
      startSession: async () => ({
        withTransaction: async (fn: () => Promise<void>) => { attempts++; await fn(); },
        endSession: async () => {}
      })
    } as any;
    const fn = async (session: unknown) => {
      if (session) throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 });
      return 'written';
    };
    expect(await withRecordTransaction(connection, fn, logger)).toBe('written');
    expect(await withRecordTransaction(connection, fn, logger)).toBe('written');
    expect(attempts).toBe(1); // the probe ran once; the second call never opened a session
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not a replica set/);
    resetTransactionProbe();
  });

  it('does not swallow an ordinary failure inside the transaction', async () => {
    resetTransactionProbe();
    const connection = {
      startSession: async () => ({ withTransaction: async (fn: () => Promise<void>) => { await fn(); }, endSession: async () => {} })
    } as any;
    await expect(withRecordTransaction(connection, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    resetTransactionProbe();
  });
});
