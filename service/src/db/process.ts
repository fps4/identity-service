/**
 * The process's store: one, from the environment, made on first use (there is no connection to open — a
 * DynamoDB call is an HTTPS request with the function's role or DynamoDB Local's indifference). The
 * server pings it at boot so a wrong table name or an unreachable endpoint fails the start, not the
 * first request; `storeReady` is what the golden-signal snapshot reads for liveness.
 */
import { CONFIG } from '../config.js';
import logger from '../utils/logger.js';
import { createStore, type Store } from './store.js';

let store: Store | null = null;
let ready = false;

export function getStore(): Store {
  if (!store) {
    if (!CONFIG.db.tableName) throw new Error('TABLE_NAME is not set: the service needs its DynamoDB table');
    store = createStore({
      tableName: CONFIG.db.tableName,
      endpoint: CONFIG.db.endpoint,
      region: CONFIG.db.region,
      workspaceId: CONFIG.record.workspaceId
    });
  }
  return store;
}

/**
 * Reach the table once, at boot, and refuse one whose shape is not this code's; the outcome is what
 * `storeReady` reports.
 */
export async function connectStore(): Promise<Store> {
  const s = getStore();
  logger.info({ table: s.tableName, endpoint: CONFIG.db.endpoint ?? 'aws' }, 'reaching DynamoDB');
  try {
    const { warnings } = await s.connect();
    for (const warning of warnings) logger.warn({ table: s.tableName }, `DynamoDB table: ${warning}`);
    ready = true;
    logger.info({ table: s.tableName }, 'DynamoDB table reachable, its shape as declared');
    return s;
  } catch (error) {
    ready = false;
    logger.error({ err: error, table: s.tableName }, 'failed to reach DynamoDB');
    throw error;
  }
}

/** True once the boot ping succeeded. */
export const storeReady = (): boolean => ready;

/** For tests and a process that reconfigures. */
export function resetStore(): void {
  store = null;
  ready = false;
}
