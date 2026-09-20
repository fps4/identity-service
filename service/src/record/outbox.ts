/**
 * The recorder (ADR-0022): every act of the principal registry — a principal registered, suspended,
 * reinstated, a seat granted or revoked — is emitted as maestro's spine envelope, in the same
 * transaction as the change, validated by the spine's own rules before insert. What the relay reads is
 * what the archive will hold; the relay carries and never translates.
 *
 * An act the spine would refuse is not performed. The recorder throws before anything is written, the
 * service's transaction aborts, and the caller gets a refusal naming why — an unrecordable act is not an
 * act with a missing event, it is an act that did not happen (maestro, docs/components/spine.md).
 */
import {
  AppendRefused,
  PRINCIPAL_ID,
  WORKSPACE_ID,
  assertEvent,
  claimedKind,
  uuidv7,
  type OversightLevel,
  type PrincipalResolver,
  type SpineEvent,
  type TypeSchemas
} from '@fps4/maestro-spine';
import type { PrincipalKind } from '../models/principal.js';
import type { Logger } from '../utils/logger.js';
import { OUTBOX_COUNTER, subjectCounter, type Store, type Transaction } from '../db/index.js';
import { loadKinds } from './registry.js';
import { RECORD_TYPES, type RecordType } from './types.js';

/** The record's configuration a recorder needs — the deployment-wide part of every envelope. */
export interface RecordConfig {
  workspaceId: string;
  accountable?: string;
  consequenceClass: string;
}

/**
 * Refuse a record configuration the spine would refuse on every emit — at boot, with the variable named,
 * rather than as a refusal on the first act.
 */
export function validateRecordConfig(config: RecordConfig): RecordConfig {
  if (!WORKSPACE_ID.test(config.workspaceId)) {
    throw new Error(`MAESTRO_WORKSPACE_ID must be a maestro workspace id (ws-<slug>); got "${config.workspaceId}"`);
  }
  if (config.accountable !== undefined && (!PRINCIPAL_ID.test(config.accountable) || claimedKind(config.accountable) !== 'human')) {
    throw new Error(`MAESTRO_ACCOUNTABLE must be a human's maestro principal id (prn-h-…); got "${config.accountable}"`);
  }
  if (!/^c[0-9]$/.test(config.consequenceClass)) {
    throw new Error(`MAESTRO_CONSEQUENCE_CLASS must be c0…c9; got "${config.consequenceClass}"`);
  }
  return config;
}

/** The seat an act is performed under: the management plane (`operator`) or self-service (`self`). */
export type ActingSeat = 'operator' | 'self';

/**
 * Who is acting. A human answers for their own act. A machine — an agent over MCP, a pipeline with an
 * admin credential — answers to the human the deployment names as accountable for its automation.
 */
export interface Actor {
  principal: string;
  kind: PrincipalKind;
  seat: ActingSeat;
}

/** What a service records. Everything else in the envelope is derived at emit. */
export interface Act {
  type: RecordType;
  /** The principal the act is about — its maestro id. */
  subject: string;
  body: Record<string, unknown>;
  occurred_at?: string;
}

export interface Attribution {
  accountable: string;
  acting: string;
  seat: ActingSeat;
  oversight_level: OversightLevel;
}

export class ActRefused extends Error {
  constructor(message: string, public readonly status = 403, public readonly code = 'act_refused') {
    super(message);
    this.name = 'ActRefused';
  }
}

/**
 * The oversight level a MACHINE actor's act carries on the operator seat. A human in the operator seat is
 * `O0` (maestro, governance-model.md). A machine there — an agent over the MCP, a workload with an admin
 * credential — acts alone and the answerable human reads the audit trail afterwards, which is `O4`: agent
 * acts, human notified. Interim: when the registry carries seat occupancy with a level per seat (M2),
 * this is read from there, and a demotion takes effect on the next act.
 */
export const MACHINE_OVERSIGHT_LEVEL: OversightLevel = 'O4';

/**
 * The attribution an act carries, from the actor alone (ADR-0022 §4). Pure, so the rule is testable
 * without a database: a human answers for their own act at `O0`; an agent or a workload answers to the
 * configured accountable human, and without one it cannot act at all.
 */
export function attributionFor(actor: Actor, config: Pick<RecordConfig, 'accountable'>): Attribution {
  if (actor.kind === 'human') {
    return { accountable: actor.principal, acting: actor.principal, seat: actor.seat, oversight_level: 'O0' };
  }
  if (!config.accountable) {
    throw new ActRefused(
      `\`${actor.principal}\` is ${article(actor.kind)} ${actor.kind} and no human is configured as answerable for this deployment's automation (MAESTRO_ACCOUNTABLE); it cannot act.`
    );
  }
  return { accountable: config.accountable, acting: actor.principal, seat: actor.seat, oversight_level: MACHINE_OVERSIGHT_LEVEL };
}

export interface RecorderDeps {
  store: Store;
  config: RecordConfig;
  actor: Actor;
  /** One per request, minted at the edge. */
  correlation_id: string;
  types?: TypeSchemas;
  now?: () => string;
  logger?: Logger;
}

export interface Recorder {
  readonly actor: Actor;
  readonly correlation_id: string;
  /**
   * Append inside the caller's transaction. Returns what will be written, in order, once the transaction
   * commits. Events of one call chain by `causation_id` to the first of them; `causation` links the
   * first to what triggered the call — or, when an act is split over several transactions, to the first
   * event of the one before.
   */
  emit(tx: Transaction, acts: Act[], causation?: string | null): Promise<SpineEvent[]>;
}

/**
 * A recorder bound to one request: one workspace, one actor, one correlation id.
 *
 * `seq` is allocated from the workspace counter, advanced in the same transaction on the condition that it
 * has not moved since it was read (ADR-0023 §3), so ordering is a property of the stream rather than of
 * when a relay happened to read it; `subject_seq` likewise, per principal. A counter that moved fails the
 * commit, and `withRecordTransaction` runs the act again from its reads.
 */
export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? (() => new Date().toISOString());
  const types = deps.types ?? RECORD_TYPES;
  const { store, config, actor } = deps;
  // Attribution depends on the actor and the configuration alone, so it is settled — or refused — here,
  // before the act's transaction opens: a machine actor with no answerable human never writes anything.
  const attribution = attributionFor(actor, config);

  return {
    actor,
    correlation_id: deps.correlation_id,
    async emit(tx, acts, causation = null) {
      if (acts.length === 0) return [];

      const known = await loadKinds(store, [attribution.accountable, attribution.acting], tx);
      const resolve: PrincipalResolver = (id) => known.get(id);

      // The workspace sequence and each subject's, as they are now; advanced below on the condition that
      // they still are when the transaction commits.
      const start = await store.counters.read(OUTBOX_COUNTER);
      const subjects = [...new Set(acts.map((act) => act.subject))];
      const subjectStart = new Map<string, number>();
      for (const subject of subjects) subjectStart.set(subject, await store.counters.read(subjectCounter(subject)));
      const subjectNext = new Map(subjectStart);

      const events: SpineEvent[] = [];
      for (let i = 0; i < acts.length; i += 1) {
        const act = acts[i];
        const subjectSeq = (subjectNext.get(act.subject) ?? 0) + 1;
        subjectNext.set(act.subject, subjectSeq);
        const recordedAt = now();
        const candidate = {
          event_id: uuidv7(),
          workspace_id: config.workspaceId,
          seq: start + i + 1,
          subject_type: 'principal',
          subject_id: act.subject,
          subject_seq: subjectSeq,
          type: act.type,
          type_version: 1,
          occurred_at: act.occurred_at ?? recordedAt,
          recorded_at: recordedAt,
          ...attribution,
          consequence_class: config.consequenceClass,
          causation_id: i === 0 ? causation : events[0].event_id,
          correlation_id: deps.correlation_id,
          body: act.body
        };
        // The spine's own rules, at emit. An event the relay would refuse never reaches the outbox — and
        // the act that would have produced it is not performed.
        try {
          events.push(assertEvent(candidate, resolve, types));
        } catch (err) {
          if (err instanceof AppendRefused) {
            deps.logger?.warn?.({ type: act.type, subject: act.subject, issues: err.issues }, 'act refused: the spine would not record it');
            throw new ActRefused(`This act cannot be recorded and is not performed: ${err.issues.map((i) => `${i.field} ${i.message}`).join('; ')}`, 400, 'unrecordable_act');
          }
          throw err;
        }
      }

      store.counters.advance(tx, OUTBOX_COUNTER, start, acts.length);
      for (const subject of subjects) {
        store.counters.advance(tx, subjectCounter(subject), subjectStart.get(subject) ?? 0, (subjectNext.get(subject) ?? 0) - (subjectStart.get(subject) ?? 0));
      }
      for (const event of events) store.outbox.put(tx, event);
      return events;
    }
  };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
