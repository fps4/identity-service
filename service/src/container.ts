import { CONFIG } from './config.js';
import { createAuthorizer, createSessionJwtSigner } from './core/index.js';
import { createOAuthServer } from './oauth/server.js';
import { createUserService } from './services/users.js';
import { createAdminService } from './services/admin.js';
import { getMasterConnection, masterConnectionReadyState } from './utils/db.js';
import { makeModels } from './models/index.js';
import { MetricsRecorder } from './observability/metrics.js';
import logger from './utils/logger.js';

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

export const oauthServer = createOAuthServer({
  getMasterConnection,
  makeModels,
  logger
});

export const userService = createUserService({
  getMasterConnection,
  makeModels,
  logger
});

export const adminService = createAdminService({
  getMasterConnection,
  makeModels,
  logger
});
