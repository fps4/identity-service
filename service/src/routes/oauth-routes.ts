import express from 'express';
import type { Request, Response } from 'express';
import { oauthServer } from '../container.js';
import { CONFIG } from '../config.js';
import { createRateLimiter } from '../utils/rate-limit.js';
import {
  OAuthError,
  InvalidRequestError,
  InvalidClientError,
  InvalidGrantError
} from '../oauth/errors.js';

const router = express.Router();

const SUPPORTED_GRANTS = new Set(['client_credentials', 'authorization_code', 'refresh_token', 'password']);

// Abuse guards on the two unauthenticated browser-login endpoints (see utils/rate-limit.ts). `authorize`
// writes an authorization record per request; `login` runs a synchronous scrypt, which blocks the event
// loop, so it gets the tighter budget.
const authorizeLimiter = createRateLimiter({
  limit: CONFIG.auth.loginRateLimit.authorizePerIpPerMinute,
  globalLimit: CONFIG.auth.loginRateLimit.authorizeGlobalPerMinute
});
const loginLimiter = createRateLimiter({
  limit: CONFIG.auth.loginRateLimit.loginPerIpPerMinute,
  globalLimit: CONFIG.auth.loginRateLimit.loginGlobalPerMinute
});

router.post('/token', async (req: Request, res: Response) => {
  const grantType = (req.body?.grant_type ?? req.query?.grant_type) as string | undefined;
  if (!grantType) {
    return handleError(res, new InvalidRequestError('grant_type is required'));
  }
  if (!SUPPORTED_GRANTS.has(grantType)) {
    return handleError(res, new InvalidRequestError(`Unsupported grant_type: ${grantType}`));
  }

  try {
    if (grantType === 'client_credentials') {
      return await handleClientCredentials(req, res);
    }
    if (grantType === 'authorization_code') {
      return await handleAuthorizationCode(req, res);
    }
    if (grantType === 'password') {
      return await handlePasswordGrant(req, res);
    }
    return await handleRefreshToken(req, res);
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return handleError(res, error);
    }
    return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
  }
});

// Browser entry point. Depending on the deployment's IdP this either redirects to Google (RQ-0001) or
// renders this service's own login form (RQ-0002).
router.get('/authorize', authorizeLimiter, async (req: Request, res: Response) => {
  try {
    const scopeParam = req.query?.scope;
    const result = await oauthServer.startAuthorization({
      clientId: String(req.query?.client_id ?? ''),
      redirectUri: String(req.query?.redirect_uri ?? ''),
      codeChallenge: String(req.query?.code_challenge ?? ''),
      codeChallengeMethod: req.query?.code_challenge_method ? String(req.query.code_challenge_method) : undefined,
      state: req.query?.state ? String(req.query.state) : undefined,
      scope: parseScope(scopeParam),
      resource: req.query?.resource ? String(req.query.resource) : undefined
    });
    if (result.mode === 'login') {
      return sendLoginPage(res, { loginToken: result.loginToken, redirectUri: result.redirectUri });
    }
    return res.redirect(302, result.redirectTo);
  } catch (error: any) {
    if (error instanceof OAuthError) {
      // Cannot trust an unvalidated redirect_uri here — surface the error directly, no redirect.
      return handleError(res, error);
    }
    return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
  }
});

// The local login form posts back here. `login_token` is the single-use handle minted with the form; it
// identifies the pending authorization, so no cookie or ambient session is involved.
router.post('/authorize/login', loginLimiter, async (req: Request, res: Response) => {
  const loginToken = String(req.body?.login_token ?? '');
  try {
    const result = await oauthServer.completeLocalLogin({
      loginToken,
      email: String(req.body?.email ?? ''),
      password: String(req.body?.password ?? '')
    });
    return res.redirect(302, result.redirectTo);
  } catch (error: any) {
    // Wrong credentials (or a lockout) leave the authorization itself intact, so re-render the form and
    // let the person retry. Anything else — expired, unknown, or already-used login token — is terminal
    // and surfaces as a plain OAuth error, since there is no form left to return to.
    if (error instanceof InvalidGrantError) {
      // Re-read the redirect target: the retry page will itself redirect on success, so it needs the
      // same `form-action` allowance as the original render.
      const context = await oauthServer.getLoginContext(loginToken).catch(() => null);
      return sendLoginPage(res, {
        loginToken,
        redirectUri: context?.redirectUri,
        error: error.description ?? error.message,
        status: 401
      });
    }
    if (error instanceof OAuthError) {
      return handleError(res, error);
    }
    return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
  }
});

// Google redirects back here with its authorization code.
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const result = await oauthServer.handleGoogleCallback({
      code: String(req.query?.code ?? ''),
      state: String(req.query?.state ?? '')
    });
    return res.redirect(302, result.redirectTo);
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return handleError(res, error);
    }
    return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
  }
});

// Revoke a refresh token (and its session). RFC 7009 — always 200, even for unknown tokens.
router.post('/revoke', async (req: Request, res: Response) => {
  try {
    await oauthServer.revokeUserToken({ token: String(req.body?.token ?? req.body?.refresh_token ?? '') });
    return res.status(200).json({ revoked: true });
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return handleError(res, error);
    }
    return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
  }
});

async function handleClientCredentials(req: Request, res: Response) {
  const credentials = extractClientCredentials(req);
  if (!credentials.clientId || !credentials.clientSecret) {
    return handleError(res, new InvalidClientError('Client credentials missing'));
  }
  const resourceParam = req.body?.resource ?? req.query?.resource;
  const token = await oauthServer.issueClientCredentialsToken({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    scope: parseScope(req.body?.scope ?? req.query?.scope),
    resource: resourceParam ? String(resourceParam) : undefined
  });
  return res.status(200).json({
    access_token: token.accessToken,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
    scope: token.scope.join(' ')
  });
}

async function handleAuthorizationCode(req: Request, res: Response) {
  // Public client + PKCE: the code_verifier authenticates the exchange, not a client_secret.
  const resourceParam = req.body?.resource ?? req.query?.resource;
  const token = await oauthServer.issueAuthorizationCodeToken({
    code: String(req.body?.code ?? ''),
    codeVerifier: String(req.body?.code_verifier ?? ''),
    clientId: String(req.body?.client_id ?? ''),
    redirectUri: String(req.body?.redirect_uri ?? ''),
    resource: resourceParam ? String(resourceParam) : undefined
  });
  return res.status(200).json(userTokenBody(token));
}

async function handlePasswordGrant(req: Request, res: Response) {
  const token = await oauthServer.issuePasswordToken({
    username: String(req.body?.username ?? ''),
    password: String(req.body?.password ?? ''),
    clientId: String(req.body?.client_id ?? '')
  });
  return res.status(200).json(userTokenBody(token));
}

async function handleRefreshToken(req: Request, res: Response) {
  const token = await oauthServer.refreshUserToken({
    refreshToken: String(req.body?.refresh_token ?? ''),
    clientId: String(req.body?.client_id ?? '')
  });
  return res.status(200).json(userTokenBody(token));
}

function userTokenBody(token: {
  accessToken: string; tokenType: string; expiresIn: number;
  refreshToken: string; refreshExpiresIn: number; scope: string[];
}) {
  return {
    access_token: token.accessToken,
    token_type: token.tokenType,
    expires_in: token.expiresIn,
    refresh_token: token.refreshToken,
    refresh_expires_in: token.refreshExpiresIn,
    scope: token.scope.join(' ')
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The origin of a pre-registered redirect URI, as a CSP source expression. Returns undefined for
 * anything unparseable, so a bad value degrades to a stricter policy rather than a broken one.
 */
function redirectOrigin(redirectUri?: string): string | undefined {
  if (!redirectUri) return undefined;
  try {
    return new URL(redirectUri).origin;
  } catch {
    return undefined;
  }
}

/**
 * The first-party login page (RQ-0002). Hand-rendered rather than templated: the service ships no view
 * engine, and an authentication page is the last place to add a dependency for the sake of syntax.
 * Every interpolated value is escaped.
 *
 * Headers matter as much as the markup here — `no-store` keeps the form (and any typed credential) out
 * of caches, and the CSP forbids scripts entirely and blocks framing, so the page cannot be clickjacked
 * into approving a login.
 *
 * `form-action` needs care. It must list the consumer's redirect origin as well as `'self'`, because
 * browsers check this directive against redirects that RESULT from the form submission, not just the
 * POST target — with `'self'` alone the browser silently refuses to follow the 302 that delivers the
 * authorization code, and the flow dies after a login the server considers successful. The origin
 * comes from `consumerRedirectUri`, which was exact-match validated against the client's registered
 * list before this page was ever rendered, so this widens the policy only to a target the deployment
 * already trusts.
 */
function sendLoginPage(
  res: Response,
  opts: { loginToken: string; redirectUri?: string; error?: string; status?: number }
) {
  const formAction = ["'self'", redirectOrigin(opts.redirectUri)].filter(Boolean).join(' ');
  const banner = opts.error
    ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { width: min(22rem, calc(100vw - 3rem)); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
  label { display: block; margin: 0 0 .35rem; font-weight: 500; }
  input { width: 100%; box-sizing: border-box; padding: .55rem .65rem; margin: 0 0 1rem;
          font: inherit; border: 1px solid GrayText; border-radius: .375rem;
          background: Field; color: FieldText; }
  button { width: 100%; padding: .6rem; font: inherit; font-weight: 600; cursor: pointer;
           border: 0; border-radius: .375rem; background: Highlight; color: HighlightText; }
  .error { padding: .6rem .75rem; margin: 0 0 1rem; border-radius: .375rem;
           background: color-mix(in srgb, Mark 40%, Canvas); font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>Sign in</h1>
  ${banner}
  <form method="post" action="/oauth2/authorize/login" autocomplete="on">
    <input type="hidden" name="login_token" value="${escapeHtml(opts.loginToken)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;

  return res
    .status(opts.status ?? 200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`
    })
    .send(html);
}

function parseScope(scopeParam: unknown): string[] {
  return typeof scopeParam === 'string' && scopeParam.trim()
    ? scopeParam.trim().split(/\s+/)
    : [];
}

function handleError(res: Response, error: OAuthError) {
  const payload: Record<string, string> = {
    error: error.error,
    error_description: error.description ?? error.message
  };
  const headers: Record<string, string> = {};
  if (error instanceof InvalidClientError) {
    headers['WWW-Authenticate'] = 'Basic realm="oauth"';
  }
  return res.status(error.status).set(headers).json(payload);
}

function extractClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization ?? req.headers.Authorization;
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const value = header.slice('Basic '.length);
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    const [clientId, clientSecret] = decoded.split(':');
    return { clientId, clientSecret };
  }

  const clientId = req.body?.client_id ?? req.query?.client_id;
  const clientSecret = req.body?.client_secret ?? req.query?.client_secret;
  return { clientId, clientSecret };
}

export default router;
