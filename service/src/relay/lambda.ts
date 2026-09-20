/**
 * The relay as a scheduled Lambda (ADR-0022 §5): the spine's `relayHandler` over this deployment's
 * outbox — the entry point `scripts/bundle.mjs` bundles and the Terraform module deploys on a schedule,
 * beside the service and the backup. The environment carries the archive bucket and the FIFO topic the
 * spine's Terraform module outputs (`ARCHIVE_BUCKET`, `ARCHIVE_PREFIX`, `EVENTS_TOPIC_ARN`) plus this
 * service's own MongoDB connection (`MONGO_URI`, `MONGO_DB_NAME`); the service itself runs with
 * `RECORD_SINK=off` there. One connection per container, made on first use. Each run logs one line in
 * CloudWatch's embedded metric format (`maestro/spine`: Archived, Published, Refused).
 */
import { relayHandler } from '@fps4/maestro-spine';
import { getMasterConnection } from '../utils/db.js';
import { makeModels } from '../models/index.js';
import { MongoOutboxSource, RECORD_TYPES } from '../record/index.js';

let source: MongoOutboxSource | undefined;

function connect(): MongoOutboxSource {
  source ??= new MongoOutboxSource(async () => makeModels(await getMasterConnection()));
  return source;
}

export async function handler() {
  const s = connect();
  return relayHandler({ component: 'identity', source: s, resolve: s.resolve, types: RECORD_TYPES })();
}
