/**
 * The outbox as the spine sees it (ADR-0022 §5): an `OutboxSource` over this deployment's `outbox`
 * collection. The relay never sees the database; it sees pending envelopes, oldest first, and
 * acknowledges them once the archive holds them and delivery accepted them.
 *
 * Principals are resolved for the relay's own check from the registry, per batch — the envelope was
 * validated at emit, and the relay checks again because that is what the relay does. A retired
 * principal still resolves: the archive must be able to say what kind of thing acted for as long as it
 * holds the event.
 */
import type { OutboxSource, PrincipalResolver, SpineEvent } from '@fps4/maestro-spine';
import type { ModelsBucket } from '../oauth/types.js';
import type { PrincipalKind } from '../models/principal.js';
import { loadKinds } from './registry.js';

const BOOKKEEPING = ['_id', 'delivered', 'delivered_at', 'attempts'] as const;

export class MongoOutboxSource implements OutboxSource {
  private readonly kinds = new Map<string, { kind: PrincipalKind }>();

  constructor(private readonly models: () => Promise<ModelsBucket>) {}

  /** The relay's resolver: whatever `pending` last loaded. */
  readonly resolve: PrincipalResolver = (id) => this.kinds.get(id);

  async pending(limit: number): Promise<SpineEvent[]> {
    const m = await this.models();
    const rows = await m.Outbox.find({ delivered: false }).sort({ workspace_id: 1, seq: 1 }).limit(limit).lean().exec() as Array<Record<string, unknown>>;
    const events = rows.map((row) => {
      const event = { ...row };
      for (const key of BOOKKEEPING) delete event[key];
      return event as unknown as SpineEvent;
    });
    const kinds = await loadKinds(m, events.flatMap((e) => [e.accountable, e.acting]));
    for (const [id, kind] of kinds) this.kinds.set(id, kind);
    return events;
  }

  async ack(events: readonly SpineEvent[]): Promise<void> {
    if (events.length === 0) return;
    const m = await this.models();
    await m.Outbox.updateMany(
      { _id: { $in: events.map((e) => e.event_id) } },
      { $set: { delivered: true, delivered_at: new Date().toISOString() }, $inc: { attempts: 1 } }
    ).exec();
  }
}
