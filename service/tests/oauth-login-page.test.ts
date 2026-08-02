/**
 * The route layer of the first-party login (RQ-0002): what the browser actually receives at
 * `/oauth2/authorize` when this service authenticates the person itself, and what happens when the form
 * posts back. The OAuth decisions live in `oauth/server.ts` and are covered by `oauth-local-login`;
 * here the oauth server is a stub, so these tests are about the HTTP surface — status codes, headers,
 * escaping, and which failures return a retryable form versus a terminal error.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { InvalidGrantError, AccessDeniedError } from '../src/oauth/errors.js';

const startAuthorization = vi.fn();
const completeLocalLogin = vi.fn();

// The routes pull the live oauth server (and therefore a Mongo connection) off the container; stub it.
vi.mock('../src/container.js', () => ({
  oauthServer: {
    startAuthorization: (...a: unknown[]) => startAuthorization(...a),
    completeLocalLogin: (...a: unknown[]) => completeLocalLogin(...a),
    issueClientCredentialsToken: vi.fn(),
    issueAuthorizationCodeToken: vi.fn(),
    issuePasswordToken: vi.fn(),
    refreshUserToken: vi.fn(),
    revokeUserToken: vi.fn(),
    handleGoogleCallback: vi.fn()
  }
}));

const { default: oauthRoutes } = await import('../src/routes/oauth-routes.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/oauth2', oauthRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});
afterAll(() => { server?.close(); });

const AUTHORIZE_QUERY =
  'client_id=client-mcp&redirect_uri=http%3A%2F%2Flocalhost%3A9876%2Fcallback&code_challenge=abc&state=xyz';

const postLogin = (body: Record<string, string>) =>
  fetch(`${base}/oauth2/authorize/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual'
  });

describe('GET /oauth2/authorize — login page', () => {
  it('renders a login form carrying the login token', async () => {
    startAuthorization.mockResolvedValueOnce({ mode: 'login', loginToken: 'tok-123' });

    const res = await fetch(`${base}/oauth2/authorize?${AUTHORIZE_QUERY}`, { redirect: 'manual' });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<form method="post" action="/oauth2/authorize/login"');
    expect(html).toContain('name="login_token" value="tok-123"');
    expect(html).toContain('name="password" type="password"');
  });

  it('sends the headers that keep a credential form out of caches and frames', async () => {
    startAuthorization.mockResolvedValueOnce({ mode: 'login', loginToken: 'tok-123' });

    const res = await fetch(`${base}/oauth2/authorize?${AUTHORIZE_QUERY}`, { redirect: 'manual' });

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");   // no scripts at all
    expect(csp).toContain("form-action 'self'");   // credentials cannot be posted off-origin
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('escapes the login token rather than reflecting markup into the page', async () => {
    startAuthorization.mockResolvedValueOnce({ mode: 'login', loginToken: '"><script>alert(1)</script>' });

    const res = await fetch(`${base}/oauth2/authorize?${AUTHORIZE_QUERY}`, { redirect: 'manual' });
    const html = await res.text();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('still redirects to the upstream IdP when the deployment federates', async () => {
    startAuthorization.mockResolvedValueOnce({ mode: 'redirect', redirectTo: 'https://accounts.google.test/auth?state=s' });

    const res = await fetch(`${base}/oauth2/authorize?${AUTHORIZE_QUERY}`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://accounts.google.test/auth?state=s');
  });

  it('passes a resource indicator through to the authorization request', async () => {
    startAuthorization.mockResolvedValueOnce({ mode: 'login', loginToken: 'tok-123' });

    await fetch(`${base}/oauth2/authorize?${AUTHORIZE_QUERY}&resource=https%3A%2F%2Fauth-mcp.fps4.nl%2Fmcp`, { redirect: 'manual' });

    expect(startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'https://auth-mcp.fps4.nl/mcp' })
    );
  });
});

describe('POST /oauth2/authorize/login', () => {
  it('redirects back to the consumer on a successful login', async () => {
    completeLocalLogin.mockResolvedValueOnce({ redirectTo: 'http://localhost:9876/callback?code=c1&state=xyz' });

    const res = await postLogin({ login_token: 'tok-123', email: 'operator@fps4.test', password: 'pw' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:9876/callback?code=c1&state=xyz');
  });

  it('re-renders the form with an error on bad credentials, so the person can retry', async () => {
    completeLocalLogin.mockRejectedValueOnce(new InvalidGrantError('Invalid credentials'));

    const res = await postLogin({ login_token: 'tok-123', email: 'operator@fps4.test', password: 'wrong' });
    const html = await res.text();

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Invalid credentials');
    expect(html).toContain('name="login_token" value="tok-123"'); // the retry keeps the same authorization
  });

  it('does not reflect a submitted password back into the retry page', async () => {
    completeLocalLogin.mockRejectedValueOnce(new InvalidGrantError('Invalid credentials'));

    const res = await postLogin({ login_token: 'tok-123', email: 'operator@fps4.test', password: 'hunter2-secret' });

    expect(await res.text()).not.toContain('hunter2-secret');
  });

  it('surfaces a terminal OAuth error when the authorization itself is gone', async () => {
    completeLocalLogin.mockRejectedValueOnce(new AccessDeniedError('Login session is invalid or expired'));

    const res = await postLogin({ login_token: 'stale', email: 'operator@fps4.test', password: 'pw' });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('access_denied'); // an error page, not a form that cannot succeed
  });

  it('does not leak internals when something unexpected throws', async () => {
    completeLocalLogin.mockRejectedValueOnce(new Error('mongo exploded at 0xdeadbeef'));

    const res = await postLogin({ login_token: 'tok-123', email: 'operator@fps4.test', password: 'pw' });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('server_error');
    expect(JSON.stringify(body)).not.toContain('0xdeadbeef');
  });
});
