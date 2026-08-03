import express from 'express';
import cors from 'cors';
import { Server } from 'http';
import { CONFIG } from './config.js';
import { getMasterConnection, disconnect } from './utils/db.js';
import logger from './utils/logger.js';
import { metricsRecorder } from './container.js';
import sessionRoutes from './routes/session-routes.js';
import oauthRoutes from './routes/oauth-routes.js';
import adminRoutes from './routes/admin-routes.js';
import { buildCorsOptions, corsErrorHandler, selfOrigins, isBrowserSameOriginRequest } from './utils/cors.js';
import { listPublicKeys, ensureActiveSigningKey } from './utils/key-store.js';
import { createMcpRouter, protectedResourceMetadata, authorizationServerMetadata } from './mcp/http-transport.js';

async function bootstrap() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '512kb' }));

  const isProd = CONFIG.environment === 'production';
  const staticOrigins = new Set(CONFIG.cors.staticOrigins);
  const devOrigins = isProd
    ? []
    : [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:8080',
        'http://127.0.0.1:8080'
      ];
  // The deployment's configured origins, plus the service's own — CORS_ORIGINS lists the CONSUMERS that
  // call this API from a browser, so it is routinely written without the issuer itself, which silently
  // breaks the first-party login form's same-origin POST (see `selfOrigins`).
  const allowedOrigins = new Set([
    ...staticOrigins,
    ...devOrigins,
    ...selfOrigins([CONFIG.auth.jwtIssuer, CONFIG.mcp.resourceUrl])
  ]);

  // A request the browser itself marks same-origin skips the allow-list entirely: there is no CORS
  // decision to make, and a form-submission navigation can arrive with `Origin: null` that no allow-list
  // could ever match (see `isBrowserSameOriginRequest`). Everything else goes through the policy.
  const corsMiddleware = cors(buildCorsOptions({ allowedOrigins, isProd, methods: Array.from(CONFIG.cors.allowedMethods) }));
  app.use((req, res, next) => (isBrowserSameOriginRequest(req) ? next() : corsMiddleware(req, res, next)));

  // Time every request into the shared rolling window. Recording only — /admin/v1/stats reads the
  // rollup on demand; nothing is pushed anywhere.
  app.use(metricsRecorder.middleware);

  await getMasterConnection();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/.well-known/jwks.json', async (_req, res) => {
    await ensureActiveSigningKey();
    const keys = await listPublicKeys();
    res.json({ keys });
  });

  app.use('/oauth2', oauthRoutes);
  app.use('/v1', sessionRoutes);

  // Management plane (ADR-0007): authenticated admin API. Every route is guarded by an admin-scoped
  // client-credentials token and writes an append-only audit entry. Disable per-deployment with
  // ADMIN_API_ENABLED=false; on ds1 it must be bound off the public tunnel (network-restricted).
  if (CONFIG.admin.enabled) {
    app.use(CONFIG.admin.basePath, adminRoutes);
    logger.info({ basePath: CONFIG.admin.basePath }, 'management API enabled');
  }

  // Remote MCP transport (ADR-0009 Phase 1): the management MCP server over MCP Streamable HTTP, as an
  // OAuth-protected resource verified through the SAME admin-auth + audit path as /admin/v1. The two
  // discovery documents let a standard MCP client find the authorization server and obtain a token.
  if (CONFIG.mcp.enabled) {
    app.get('/.well-known/oauth-protected-resource', (_req, res) => { res.json(protectedResourceMetadata()); });
    app.get('/.well-known/oauth-authorization-server', (_req, res) => { res.json(authorizationServerMetadata()); });
    app.use(CONFIG.mcp.basePath, createMcpRouter());
    logger.info({ basePath: CONFIG.mcp.basePath, resource: CONFIG.mcp.resourceUrl }, 'MCP HTTP transport enabled');
  }

  // A disallowed CORS Origin reaches here as a tagged error; return a clean 403 JSON (OAuth-style)
  // rather than Express's default 500 HTML. Other errors fall through to the default handler.
  app.use(corsErrorHandler);

  let server: Server;

  server = app.listen(CONFIG.port, () => {
    logger.info({ port: CONFIG.port }, 'identity-service is running');
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, 'error while closing server');
        process.exit(1);
        return;
      }
      await disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  logger.error({ err: error }, 'failed to start identity-service');
  process.exit(1);
});
