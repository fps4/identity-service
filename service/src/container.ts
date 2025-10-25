import { CONFIG } from './config.js';
import { createAuthorizer, createSessionJwtSigner } from './core/index.js';
import { getMasterConnection } from './utils/db.js';
import { makeModels } from './models/index.js';
import logger from './utils/logger.js';

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
