/**
 * The outbox as the spine sees it (ADR-0022 §5): an `OutboxSource` over this deployment's outbox items.
 * The relay never sees the table; it sees pending envelopes, oldest first, and acknowledges them once
 * the archive holds them and delivery accepted them.
 *
 * Pending items come from the sparse `pending` index (ADR-0023 §2), which is eventually consistent: an
 * item acknowledged a moment ago may be read once more. The archive's append is exactly-once by
 * `(workspace, seq)`, so it is skipped there and delivered again at most — at-least-once out, as the
 * spine's rule has it.
 *
 * Principals are resolved for the relay's own check from the registry, per batch — the envelope was
 * validated at emit, and the relay checks again because that is what the relay does. A retired
 * principal still resolves: the archive must be able to say what kind of thing acted for as long as it
 * holds the event.
 */
import type { OutboxSource, PrincipalResolver, SpineEvent } from '@fps4/maestro-spine';
import type { Store } from '../db/index.js';
import type { PrincipalKind } from '../models/principal.js';
import { loadKinds } from './registry.js';

export class DynamoOutboxSource implements OutboxSource {
  private readonly kinds = new Map<string, { kind: PrincipalKind }>();

  constructor(private readonly store: () => Promise<Store>) {}

  /** The relay's resolver: whatever `pending` last loaded. */
  readonly resolve: PrincipalResolver = (id) => this.kinds.get(id);

  async pending(limit: number): Promise<SpineEvent[]> {
    const s = await this.store();
    const events = await s.outbox.pending(limit);
    const kinds = await loadKinds(s, events.flatMap((e) => [e.accountable, e.acting]));
    for (const [id, kind] of kinds) this.kinds.set(id, kind);
    return events;
  }

  async ack(events: readonly SpineEvent[]): Promise<void> {
    if (events.length === 0) return;
    const s = await this.store();
    await s.outbox.ack(events);
  }
}
