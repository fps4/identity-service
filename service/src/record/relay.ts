/**
 * The relay, built from configuration (ADR-0022 §5): the spine's `relayOnce` over this service's outbox,
 * into the archive and delivery the sink names. `local` is the laptop's spine — a directory and an
 * in-process delivery — and `spine-verify` reads that directory with everything off. `s3` is maestro's.
 * `off` writes the outbox and relays nothing in-process; the scheduled Lambda (`./lambda.ts`) drains it.
 */
import {
  FsArchive,
  InProcessDelivery,
  S3Archive,
  SnsFifoDelivery,
  relayOnce,
  relayUntilDrained,
  type ArchiveStore,
  type Delivery,
  type RelayReport
} from '@fps4/maestro-spine';
import type { Store } from '../db/index.js';
import type { Logger } from '../utils/logger.js';
import { RECORD_TYPES } from './types.js';
import { DynamoOutboxSource } from './source.js';

export interface RecordSinkConfig {
  sink: 'local' | 's3' | 'off';
  archiveDir: string;
  archiveBucket?: string;
  archivePrefix?: string;
  eventsTopicArn?: string;
}

export interface Relay {
  once(): Promise<RelayReport>;
  drain(): Promise<RelayReport>;
  readonly archive: ArchiveStore;
  readonly delivery: Delivery;
}

export function sinkFor(config: RecordSinkConfig): { archive: ArchiveStore; delivery: Delivery } | null {
  if (config.sink === 'off') return null;
  if (config.sink === 's3') {
    if (!config.archiveBucket || !config.eventsTopicArn) {
      throw new Error('RECORD_SINK=s3 requires ARCHIVE_BUCKET and EVENTS_TOPIC_ARN');
    }
    return {
      archive: new S3Archive({ bucket: config.archiveBucket, prefix: config.archivePrefix }),
      delivery: new SnsFifoDelivery({ topicArn: config.eventsTopicArn })
    };
  }
  return { archive: new FsArchive(config.archiveDir), delivery: new InProcessDelivery() };
}

export function createRelay(store: () => Promise<Store>, sink: { archive: ArchiveStore; delivery: Delivery }): Relay {
  const source = new DynamoOutboxSource(store);
  const deps = { source, archive: sink.archive, delivery: sink.delivery, resolve: source.resolve, types: RECORD_TYPES };
  return {
    archive: sink.archive,
    delivery: sink.delivery,
    once: () => relayOnce(deps),
    drain: () => relayUntilDrained(deps)
  };
}

/**
 * Drain on an interval inside the running service. A refusal is logged on every pass it persists —
 * relay lag is the alarm, and an operator reading the log should see the `seq` that stops the workspace.
 * Returns the stopper.
 */
export function startRelayLoop(relay: Relay, intervalMs: number, logger?: Logger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const report = await relay.drain();
      if (report.refused.length > 0) {
        logger?.error?.({ refused: report.refused }, 'record: the relay refused an event; its workspace is stopped until it is resolved');
      } else if (report.acked > 0) {
        logger?.debug?.({ acked: report.acked, archived: report.archived }, 'record: relayed');
      }
    } catch (err) {
      logger?.error?.({ err }, 'record: relay pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
