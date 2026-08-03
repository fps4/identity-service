import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import cors from 'cors';
import type { Server } from 'http';

// The rejection path logs; capture it rather than letting pino write through the suite.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../src/utils/logger.js', () => {
  const stub = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { default: stub, logger: stub };
});

const { buildCorsOptions, corsErrorHandler, selfOrigins } = await import('../src/utils/cors.js');

// Regression: a disallowed Origin used to hit cors's `callback(new Error())` and surface as Express's
// default 500 HTML. It must instead be a clean 403 JSON, while allowed / origin-less requests pass.

function makeApp() {
  const app = express();
  app.use(express.json());
  // Non-empty allow-list so the "no allow-list → permissive" escape hatch does not apply.
  app.use(cors(buildCorsOptions({ allowedOrigins: new Set(['https://ok.example']), isProd: true, methods: ['GET', 'POST'] })));
  app.post('/oauth2/token', (_req, res) => { res.json({ ok: true }); });
  app.use(corsErrorHandler);
  return app;
}

describe('CORS origin handling', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = makeApp().listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (headers: Record<string, string> = {}) =>
    fetch(`${base}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  it('returns a clean 403 JSON for a disallowed Origin (not a 500)', async () => {
    const res = await post({ Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({ error: 'origin_not_allowed' });
  });

  // The client is told only `origin_not_allowed`, and a browser will not show the `Origin` it generated,
  // so a rejection used to be invisible from both ends — diagnosing one meant capturing packets.
  it('logs the refused origin, method and path so the 403 is diagnosable from the server', async () => {
    warn.mockClear();
    await post({ Origin: 'https://evil.example' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      origin: 'https://evil.example',
      method: 'POST',
      path: '/oauth2/token'
    });
  });

  it('allows a request with no Origin (non-browser caller)', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('allows an allow-listed Origin', async () => {
    const res = await post({ Origin: 'https://ok.example' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://ok.example');
  });
});

// Regression: CORS_ORIGINS lists the browser CONSUMERS of this API, so deployments write it without the
// issuer itself (ds1 had auth.fps4.nl missing). The first-party login page is served FROM the issuer and
// posts back to it, and a browser attaches `Origin` even to a same-origin POST — so that sign-in submit
// was rejected with `origin_not_allowed`, breaking the interactive MCP operator login. server.ts folds
// `selfOrigins` into the allow-list; these cover the derivation and the flow it unblocks.

describe('selfOrigins', () => {
  it('reduces the published URLs to bare origins', () => {
    expect(selfOrigins(['https://auth.fps4.nl', 'https://auth-mcp.fps4.nl/mcp']))
      .toEqual(['https://auth.fps4.nl', 'https://auth-mcp.fps4.nl']);
  });

  it('skips unset and unparseable entries rather than throwing at boot', () => {
    expect(selfOrigins([undefined, '', 'not a url', 'http://localhost:7305'])).toEqual(['http://localhost:7305']);
  });
});

describe('first-party login POST from the issuer origin', () => {
  const ISSUER = 'https://auth.fps4.nl';
  const MCP_RESOURCE = 'https://auth-mcp.fps4.nl/mcp';
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    // Mirrors server.ts: a deployment allow-list that names only consumers, never the service itself.
    const allowedOrigins = new Set(['https://ids.fps4.nl', ...selfOrigins([ISSUER, MCP_RESOURCE])]);
    app.use(cors(buildCorsOptions({ allowedOrigins, isProd: true, methods: ['GET', 'POST'] })));
    app.post('/oauth2/authorize/login', (_req, res) => { res.status(302).set('Location', 'http://localhost:9414/callback?code=x').end(); });
    app.use(corsErrorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const submit = (origin: string) =>
    fetch(`${base}/oauth2/authorize/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams({ login_token: 'tok-123', email: 'a@b.c', password: 'pw' }).toString(),
      redirect: 'manual'
    });

  it('accepts the form submit carrying the issuer as Origin', async () => {
    const res = await submit(ISSUER);
    expect(res.status).toBe(302);
  });

  it('accepts a submit from the MCP resource origin', async () => {
    const res = await submit('https://auth-mcp.fps4.nl');
    expect(res.status).toBe(302);
  });

  it('still rejects a foreign Origin', async () => {
    const res = await submit('https://evil.example');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'origin_not_allowed' });
  });
});
