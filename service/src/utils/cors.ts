import type cors from 'cors';
import type { Request, Response, NextFunction } from 'express';
import logger from './logger.js';

/** Marker on the Error a rejected CORS origin produces, so the error handler can map it to a 403. */
export const CORS_FORBIDDEN = 'cors_forbidden';

/** Dev-only: allow loopback / RFC-1918 private origins so local consumers work without per-tenant config. */
function isPrivateNetworkOriginAllowed(origin: string, isProd: boolean): boolean {
  if (isProd) return false;
  try {
    const { hostname } = new URL(origin);
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    return /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  } catch {
    return false;
  }
}

/**
 * True when the BROWSER ITSELF states the request is not cross-site: `Sec-Fetch-Site: same-origin`, or
 * `none` for a user-typed URL / bookmark.
 *
 * Why this is needed even though same-origin requests carry a matching `Origin`: they do not always.
 * Chromium derives the `Origin` of a form-submission NAVIGATION from the document's referrer policy, so
 * the first-party sign-in page — served `Referrer-Policy: no-referrer` on purpose, to keep the authorize
 * URL's `state` / `code_challenge` from leaking onward — submits its own form with `Origin: null`. No
 * allow-list can match that, and the deployment rejected its own login with `origin_not_allowed`.
 *
 * The deeper point is that CORS does not govern top-level navigations at all; it gates script-initiated
 * cross-origin fetches. Consulting the allow-list for a form submit was never a meaningful check, and the
 * CSRF defence on that route is the single-use `login_token`, which this does not touch.
 *
 * `Sec-Fetch-*` is a forbidden header name — page script cannot set or forge it, so a browser's word here
 * is trustworthy. A non-browser caller could send it, but such a caller can equally omit `Origin`, which
 * is already allowed (CORS is browser-enforced, not an auth gate), so this concedes nothing new.
 */
export function isBrowserSameOriginRequest(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  return site === 'same-origin' || site === 'none';
}

/**
 * The service's OWN public origins, derived from the URLs it publishes (the token issuer, the MCP
 * resource). These must always be allowed: the sign-in page is served from the issuer and its form posts
 * back to it, and a browser attaches `Origin` to any non-GET request — including a SAME-origin form
 * submit. An allow-list that omits the issuer therefore rejects this service's own login flow with
 * `origin_not_allowed`. Self-allowing concedes nothing: a same-origin request is not what CORS defends
 * against. Unparseable / unset URLs are skipped rather than throwing at boot.
 */
export function selfOrigins(urls: Array<string | undefined>): string[] {
  return urls.flatMap((u) => {
    if (!u) return [];
    try {
      return [new URL(u).origin];
    } catch {
      return [];
    }
  });
}

/**
 * Build the CORS options for the service. A disallowed Origin is rejected via a TAGGED error
 * ({@link CORS_FORBIDDEN}); pair this with {@link corsErrorHandler} so the rejection becomes a clean
 * 403 JSON instead of Express's default 500 HTML. A request with no Origin (non-browser callers) is
 * always allowed — CORS is browser-enforced, not an auth gate.
 */
export function buildCorsOptions(opts: {
  allowedOrigins: Set<string>;
  isProd: boolean;
  methods: string[];
}): cors.CorsOptions {
  const { allowedOrigins, isProd, methods } = opts;
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin) || isPrivateNetworkOriginAllowed(origin, isProd)) {
        return callback(null, true);
      }
      // No allow-list configured at all → permissive (bootstrap). Set CORS_ORIGINS to lock it down.
      if (allowedOrigins.size === 0) {
        return callback(null, true);
      }
      return callback(Object.assign(new Error('Origin not allowed by CORS'), { code: CORS_FORBIDDEN }));
    },
    methods,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204
  };
}

/**
 * Express error handler that turns a {@link CORS_FORBIDDEN} rejection into a 403 JSON (OAuth-style),
 * rather than letting it fall through to Express's default 500 HTML. Other errors pass through.
 * Register it AFTER the routes.
 */
export function corsErrorHandler(
  err: (Error & { code?: string }) | undefined,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err && err.code === CORS_FORBIDDEN) {
    if (res.headersSent) return next(err);
    // Say WHICH origin was refused, and where. The client is told only `origin_not_allowed`, and a
    // browser will not show the `Origin` header it generated — so without this line the server side of a
    // rejected sign-in is indistinguishable from any other 403, and diagnosing one costs a packet
    // capture. `Origin` is a public request header, not a credential; the rest is ordinary request shape.
    logger.warn(
      { origin: req.headers.origin, method: req.method, path: req.originalUrl, host: req.headers.host },
      'rejected a request whose Origin is not allowed'
    );
    res.status(403).json({ error: 'origin_not_allowed', error_description: 'Origin not allowed' });
    return;
  }
  next(err);
}
