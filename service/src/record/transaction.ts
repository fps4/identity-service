/**
 * Run a service's writes and the recorder's emit as one unit (ADR-0022 §1, ADR-0023 §3).
 *
 * The function reads what it needs and adds its writes to the transaction; the recorder adds the outbox
 * items and advances the counters on the condition that they have not moved since it read them. The
 * commit is one `TransactWriteItems`: the change and its record land together or not at all. DynamoDB
 * transactions always exist, so there is no standalone-server fallback and no "written beside the
 * change" — an act that cannot be recorded is not performed.
 *
 * Two acts that race on one workspace serialise on the counter: the second's condition fails and it is
 * run again, from its reads, so what it records is what it changed. A caller's own failed condition — an
 * email taken, an id in use — is not retried; it is the caller's answer.
 */
import type { Store } from '../db/index.js';
import { Transaction, isRecordConflict } from '../db/index.js';
import type { Logger } from '../utils/logger.js';

const MAX_ATTEMPTS = 6;

export async function withRecordTransaction<T>(
  store: Store,
  fn: (tx: Transaction) => Promise<T>,
  logger?: Logger
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const tx = new Transaction();
    const result = await fn(tx);
    try {
      await store.commit(tx);
      return result;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isRecordConflict(err)) {
        logger?.debug?.({ attempt, reason: (err as Error).message }, 'record: the workspace sequence moved under this act; retrying from its reads');
        await new Promise((resolve) => setTimeout(resolve, 5 * attempt * attempt));
        continue;
      }
      throw err;
    }
  }
}
