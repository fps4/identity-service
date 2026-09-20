/**
 * maestro's record, from this service's side (ADR-0022): the principal registry mints maestro principal
 * ids and emits its lifecycle — `PrincipalRegistered`, `PrincipalSuspended`, `PrincipalReinstated`,
 * `SeatOccupancyChanged` — to the spine through a transactional outbox that a relay drains.
 */
export { mintPrincipalId, kindOfPrincipalId, realmOf } from './ids.js';
export {
  RECORD_TYPES,
  RECORD_TYPE_NAMES,
  PRINCIPAL_KINDS,
  REGISTRATION_SOURCES,
  SUSPENSION_REASONS,
  REINSTATEMENT_REASONS,
  SEAT_CHANGES,
  isBodyToken,
  type RecordType,
  type RegistrationSource,
  type SuspensionReason,
  type ReinstatementReason,
  type SeatChange
} from './types.js';
export {
  clientPrincipalKind,
  principalStatusOf,
  ensureUserPrincipal,
  ensureClientPrincipal,
  setPrincipalStatus,
  loadKinds,
  type KnownPrincipal
} from './registry.js';
export {
  attributionFor,
  createRecorder,
  validateRecordConfig,
  ActRefused,
  MACHINE_OVERSIGHT_LEVEL,
  type Act,
  type Actor,
  type ActingSeat,
  type Attribution,
  type RecordConfig,
  type Recorder,
  type RecorderDeps
} from './outbox.js';
export { withRecordTransaction, resetTransactionProbe } from './transaction.js';
export { actContextFor, selfContext, operatorContext, type ActContext } from './context.js';
export { MongoOutboxSource } from './source.js';
export { sinkFor, createRelay, startRelayLoop, type Relay, type RecordSinkConfig } from './relay.js';
