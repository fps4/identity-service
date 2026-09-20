/**
 * Run a service's writes and the recorder's emit as one unit (ADR-0022 §1).
 *
 * MongoDB transactions need a replica set (Atlas Flex is one; the compose loop's single `mongod` is not).
 * A deployment without them still records — the outbox row lands beside the change, just not atomically
 * with it — so the check is a capability probe, made once: the first transactional command against a
 * standalone server fails with code 20 before anything is written, and from then on the function runs
 * without a session. The probe's outcome is logged once, because "the record is not atomic here" is
 * something an operator should read at boot rather than infer at an audit.
 */
import type { ClientSession, Connection } from 'mongoose';
import type { Logger } from '../utils/logger.js';

let transactionsSupported: boolean | undefined;

const NO_REPLICA_SET = /Transaction numbers are only allowed on a replica set member or mongos/i;

/** For tests and a process that reconnects elsewhere. */
export function resetTransactionProbe(): void {
  transactionsSupported = undefined;
}

export async function withRecordTransaction<T>(
  connection: Connection,
  fn: (session: ClientSession | undefined) => Promise<T>,
  logger?: Logger
): Promise<T> {
  if (transactionsSupported === false || typeof connection.startSession !== 'function') {
    return fn(undefined);
  }
  const session = await connection.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    if (transactionsSupported === undefined) {
      transactionsSupported = true;
      logger?.info?.('record: transactions supported; the outbox is written atomically with each change');
    }
    return result;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (transactionsSupported === undefined && (code === 20 || NO_REPLICA_SET.test((err as Error).message ?? ''))) {
      transactionsSupported = false;
      logger?.warn?.('record: this MongoDB is not a replica set, so the outbox is written beside each change rather than atomically with it; use a replica set where the record must be exact');
      return fn(undefined);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}
