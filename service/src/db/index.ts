/**
 * The data access (ADR-0023, maestro ADR-0018): one DynamoDB table per deployment, keyed `pk`/`sk`,
 * every act one transaction. `createStore` makes the store the services are given; `getStore` is the
 * process's one, from the environment; `table.ts` is the schema, for DynamoDB Local and for reading
 * beside the Terraform module.
 */
export { createStore, type Store, type StoreConfig } from './store.js';
export { getStore, connectStore, storeReady, resetStore } from './process.js';
export { createTableInput, ensureTable, deleteTable, describeAndCheck, tableShapeDifferences, TableShapeMismatch, INDEXES, KEY, TTL_ATTRIBUTE } from './table.js';
export { Transaction, ConditionFailed, TransactionConflict, isRecordConflict, RECORD_LABEL, TRANSACTION_LIMIT } from './transaction.js';
export { OUTBOX_COUNTER, subjectCounter } from './counters.js';
export { fromItem, toAttributes, epochSeconds, padSeq, ITEM_ATTRIBUTES } from './codec.js';
export type { Key } from './keys.js';
