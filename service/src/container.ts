import { CONFIG } from './config.js';
import { createAuthorizer, createSessionJwtSigner } from './core/index.js';
import { createOAuthServer } from './oauth/server.js';
import { createUserService } from './services/users.js';
import { createAdminService } from './services/admin.js';
import { getMasterConnection, masterConnectionReadyState } from './utils/db.js';
import { makeModels } from './models/index.js';
import { MetricsRecorder } from './observability/metrics.js';
import logger from './utils/logger.js';
import { createRelay, sinkFor, validateRecordConfig, type RecordConfig, type Relay } from './record/index.js';

// Shared golden-signal recorder: the HTTP layer feeds it via middleware, /admin/v1/stats reads it.
export const metricsRecorder = new MetricsRecorder({
  windowMs: CONFIG.observability.metricsWindowMs,
  dependencyHealthy: () => masterConnectionReadyState() === 1
});

const sessionJwtSigner = createSessionJwtSigner(() => ({
  secret: CONFIG.auth.jwtSecret,
  issuer: CONFIG.auth.jwtIssuer,
  audience: CONFIG.auth.jwtAudience
}));

export const authorizer = createAuthorizer({
  getMasterConnection,
  makeModels,
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
  getMasterConnection,
  makeModels,
  logger,
  record: recordConfig
});

export const userService = createUserService({
  getMasterConnection,
  makeModels,
  logger,
  record: recordConfig
});

export const adminService = createAdminService({
  getMasterConnection,
  makeModels,
  logger,
  record: recordConfig
});

// The relay from this service's outbox into the archive the sink names, or null for `off` (a scheduled
// Lambda drains the outbox instead — `relay/lambda.ts`).
const sink = sinkFor(CONFIG.record);
export const relay: Relay | null = sink
  ? createRelay(async () => makeModels(await getMasterConnection()), sink)
  : null;
