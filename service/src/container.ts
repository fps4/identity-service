import { CONFIG } from './config.js';
import { createAuthorizer, createSessionJwtSigner } from './core/index.js';
import { createOAuthServer } from './oauth/server.js';
import { createUserService } from './services/users.js';
import { createAdminService } from './services/admin.js';
import { getStore, storeReady } from './db/index.js';
import { MetricsRecorder } from './observability/metrics.js';
import logger from './utils/logger.js';
import { createRelay, sinkFor, validateRecordConfig, type RecordConfig, type Relay } from './record/index.js';

// Shared golden-signal recorder: the HTTP layer feeds it via middleware, /admin/v1/stats reads it.
export const metricsRecorder = new MetricsRecorder({
  windowMs: CONFIG.observability.metricsWindowMs,
  dependencyHealthy: storeReady
});

// The table (ADR-0023): one store for the process, from TABLE_NAME / DYNAMODB_ENDPOINT / AWS_REGION.
export const store = getStore();

const sessionJwtSigner = createSessionJwtSigner(() => ({
  secret: CONFIG.auth.jwtSecret,
  issuer: CONFIG.auth.jwtIssuer,
  audience: CONFIG.auth.jwtAudience
}));

export const authorizer = createAuthorizer({
  store,
  signJwt: sessionJwtSigner,
  sessionTtlMinutes: CONFIG.auth.sessionTtlMinutes,
  logger
});

// maestro's record (ADR-0022): the deployment-wide part of every envelope this service emits. Always
// wired; a machine actor's act is refused (and logged) until MAESTRO_ACCOUNTABLE names its human.
export const recordConfig: RecordConfig = validateRecordConfig({
  workspaceId: CONFIG.record.workspaceId,
  accountable: CONFIG.record.accountable,
  consequenceClass: CONFIG.record.consequenceClass
});

export const oauthServer = createOAuthServer({
  store,
  logger,
  record: recordConfig
});

export const userService = createUserService({
  store,
  logger,
  record: recordConfig
});

export const adminService = createAdminService({
  store,
  logger,
  record: recordConfig
});

// The relay from this service's outbox into the archive the sink names, or null for `off` (a scheduled
// Lambda drains the outbox instead — `relay/lambda.ts`).
const sink = sinkFor(CONFIG.record);
export const relay: Relay | null = sink
  ? createRelay(async () => store, sink)
  : null;
