import { describe, it, expect } from 'vitest';
import { PRINCIPAL_ID, checkEvent, typeKey } from '@fps4/maestro-spine';
import {
  attributionFor,
  ActRefused,
  MACHINE_OVERSIGHT_LEVEL,
  mintPrincipalId,
  kindOfPrincipalId,
  realmOf,
  clientPrincipalKind,
  isBodyToken,
  validateRecordConfig,
  RECORD_TYPES,
  RECORD_TYPE_NAMES
} from '../src/record/index.js';

/**
 * ADR-0022 as rules with no database behind them: who an act is answerable to, at what oversight level,
 * what a principal id looks like, and what a body may carry.
 */

const human = { principal: 'prn-h-abc123', kind: 'human' as const, seat: 'operator' as const };
const agent = { principal: 'prn-a-abc123', kind: 'agent' as const, seat: 'operator' as const };
const workload = { principal: 'prn-w-abc123', kind: 'workload' as const, seat: 'operator' as const };

describe('attributionFor (ADR-0022 §4)', () => {
  it('a human answers for their own act, at O0, in the seat they act from', () => {
    expect(attributionFor(human, {})).toEqual({ accountable: 'prn-h-abc123', acting: 'prn-h-abc123', seat: 'operator', oversight_level: 'O0' });
    expect(attributionFor({ ...human, seat: 'self' }, {}).seat).toBe('self');
  });

  it('an agent or a workload answers to the configured accountable human', () => {
    const a = attributionFor(agent, { accountable: 'prn-h-operator' });
    expect(a).toEqual({ accountable: 'prn-h-operator', acting: 'prn-a-abc123', seat: 'operator', oversight_level: MACHINE_OVERSIGHT_LEVEL });
    expect(attributionFor(workload, { accountable: 'prn-h-operator' }).acting).toBe('prn-w-abc123');
  });

  it('a machine actor with no answerable human configured cannot act, and the refusal names the variable', () => {
    expect(() => attributionFor(agent, {})).toThrow(ActRefused);
    expect(() => attributionFor(workload, { accountable: undefined })).toThrow(/MAESTRO_ACCOUNTABLE/);
  });

  it('a machine actor never records O0: the human is not in the loop of its act', () => {
    expect(MACHINE_OVERSIGHT_LEVEL).not.toBe('O0');
  });
});

describe('principal ids', () => {
  it('mint in the spine\'s grammar with the kind letter first', () => {
    for (const kind of ['human', 'agent', 'workload'] as const) {
      const id = mintPrincipalId(kind);
      expect(id).toMatch(PRINCIPAL_ID);
      expect(kindOfPrincipalId(id)).toBe(kind);
    }
    expect(mintPrincipalId('human')).toMatch(/^prn-h-[0-9a-hjkmnp-tv-z]{12}$/);
    expect(mintPrincipalId('human')).not.toBe(mintPrincipalId('human'));
  });

  it('a credential is an agent when it declares so, a workload when it is a machine credential, and no principal when it logs people in', () => {
    expect(clientPrincipalKind({ grantTypes: ['client_credentials'], claims: { principal_kind: 'agent' } })).toBe('agent');
    expect(clientPrincipalKind({ grantTypes: ['client_credentials'], claims: { role: 'product_runtime' } })).toBe('workload');
    expect(clientPrincipalKind({ grantTypes: ['client_credentials'] })).toBe('workload');
    expect(clientPrincipalKind({ grantTypes: ['password'] })).toBeNull();
    expect(clientPrincipalKind({ grantTypes: ['authorization_code'], claims: { principal_kind: 'agent' } })).toBeNull();
  });

  it('the realm token is the workspace id without its prefix', () => {
    expect(realmOf('ws-identity-dev')).toBe('identity-dev');
    expect(realmOf('ws-aannemer-x')).toBe('aannemer-x');
  });
});

describe('the three types and their bodies (ADR-0022 §3)', () => {
  const schema = (type: string) => RECORD_TYPES.get(typeKey(type, 1))!;

  it('are declared, versioned, and no more', () => {
    expect(RECORD_TYPE_NAMES.sort()).toEqual(['PrincipalRegistered', 'PrincipalReinstated', 'PrincipalSuspended', 'SeatOccupancyChanged']);
    for (const name of RECORD_TYPE_NAMES) expect(RECORD_TYPES.has(typeKey(name, 1))).toBe(true);
  });

  it('PrincipalRegistered carries a kind, a source and a realm — tokens only', () => {
    expect(schema('PrincipalRegistered').safeParse({ kind: 'human', source: 'local', realm: 'identity-dev' }).success).toBe(true);
    expect(schema('PrincipalRegistered').safeParse({ kind: 'human', source: 'local', realm: 'Jan Dekker' }).success).toBe(false);
    expect(schema('PrincipalRegistered').safeParse({ kind: 'person', source: 'local', realm: 'r' }).success).toBe(false);
    expect(schema('PrincipalRegistered').safeParse({ kind: 'human', source: 'local', realm: 'r', email: 'a@b.c' }).success).toBe(false);
  });

  it('PrincipalSuspended and PrincipalReinstated carry a reason from a closed set', () => {
    expect(schema('PrincipalSuspended').safeParse({ reason: 'disabled' }).success).toBe(true);
    expect(schema('PrincipalSuspended').safeParse({ reason: 'deleted' }).success).toBe(true);
    expect(schema('PrincipalSuspended').safeParse({ reason: 'left the company' }).success).toBe(false);
    expect(schema('PrincipalReinstated').safeParse({ reason: 'enabled' }).success).toBe(true);
    expect(schema('PrincipalReinstated').safeParse({ reason: 'disabled' }).success).toBe(false);
  });

  it('SeatOccupancyChanged names a seat, an application, a change and a level — never a name', () => {
    expect(schema('SeatOccupancyChanged').safeParse({ seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O0' }).success).toBe(true);
    expect(schema('SeatOccupancyChanged').safeParse({ seat: 'senior reviewer', application: 'app1', change: 'granted', oversight_level: 'O0' }).success).toBe(false);
    expect(schema('SeatOccupancyChanged').safeParse({ seat: 'reviewer', application: 'app1', change: 'moved', oversight_level: 'O0' }).success).toBe(false);
    expect(schema('SeatOccupancyChanged').safeParse({ seat: 'reviewer', application: 'app1', change: 'granted', oversight_level: 'O5' }).success).toBe(false);
  });

  it('the spine refuses free text through the floor even where a type does not narrow it', () => {
    const resolve = (id: string) => (id.startsWith('prn-h-') ? { kind: 'human' as const } : undefined);
    const base = {
      event_id: '018f4b2e-7c3a-7d6e-8f1a-0123456789ab', workspace_id: 'ws-identity-dev', seq: 1,
      subject_type: 'principal', subject_id: 'prn-h-x', subject_seq: 1, type: 'PrincipalSuspended', type_version: 1,
      occurred_at: '2026-09-20T00:00:00Z', recorded_at: '2026-09-20T00:00:00Z',
      accountable: 'prn-h-x', acting: 'prn-h-x', seat: 'operator', oversight_level: 'O0', consequence_class: 'c1',
      causation_id: null, correlation_id: '018f4b2e-7c3a-7d6e-8f1a-0123456789ac', body: { reason: 'disabled' }
    };
    expect(checkEvent(base, resolve, RECORD_TYPES)).toEqual([]);
    expect(checkEvent({ ...base, body: { reason: 'disabled', note: 'asked by his manager' } }, resolve, RECORD_TYPES).length).toBeGreaterThan(0);
    expect(checkEvent({ ...base, accountable: 'prn-a-x', acting: 'prn-a-x' }, (id) => ({ kind: id.startsWith('prn-a') ? 'agent' : 'human' }), RECORD_TYPES)[0]?.field).toBe('accountable');
  });

  it('a seat or application id is a body token', () => {
    expect(isBodyToken('platform_admin')).toBe(true);
    expect(isBodyToken('mstr-specs')).toBe(true);
    expect(isBodyToken('a role with spaces')).toBe(false);
    expect(isBodyToken('')).toBe(false);
  });
});

describe('validateRecordConfig', () => {
  it('accepts what the spine accepts and names the variable for what it would not', () => {
    expect(validateRecordConfig({ workspaceId: 'ws-identity-dev', consequenceClass: 'c1' }).workspaceId).toBe('ws-identity-dev');
    expect(validateRecordConfig({ workspaceId: 'ws-x', accountable: 'prn-h-op', consequenceClass: 'c2' }).accountable).toBe('prn-h-op');
    expect(() => validateRecordConfig({ workspaceId: 'identity-dev', consequenceClass: 'c1' })).toThrow(/MAESTRO_WORKSPACE_ID/);
    expect(() => validateRecordConfig({ workspaceId: 'ws-x', accountable: 'prn-a-agent', consequenceClass: 'c1' })).toThrow(/MAESTRO_ACCOUNTABLE.*human/);
    expect(() => validateRecordConfig({ workspaceId: 'ws-x', accountable: 'someone@example.test', consequenceClass: 'c1' })).toThrow(/MAESTRO_ACCOUNTABLE/);
    expect(() => validateRecordConfig({ workspaceId: 'ws-x', consequenceClass: 'high' })).toThrow(/MAESTRO_CONSEQUENCE_CLASS/);
  });
});
