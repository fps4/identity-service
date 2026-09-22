/**
 * The set-password page: what the browser receives when a person opens a link an operator issued
 * (services/password-links.ts), and what happens when the form posts back. Server-rendered like the
 * first-party login (oauth-routes.ts): no script, a strict CSP, `no-store`, never indexed. The token
 * travels in the URL the person was handed and in a hidden field; the page shows whose link it is
 * and asks for the password twice.
 */
import express, { type Request, type Response } from 'express';
import { passwordLinkService } from '../container.js';
import { CONFIG } from '../config.js';
import { UserServiceError } from '../services/users.js';
import logger from '../utils/logger.js';
import { createRateLimiter } from '../utils/rate-limit.js';

const router = express.Router();

// The page is public by nature — a link is opened by whoever holds it. A token is 256 random bits, so
// guessing is not the risk; the budget is the login's: a GET reads two items, a POST runs scrypt.
const pageLimiter = createRateLimiter({
  limit: CONFIG.auth.loginRateLimit.authorizePerIpPerMinute,
  globalLimit: CONFIG.auth.loginRateLimit.authorizeGlobalPerMinute
});
const setLimiter = createRateLimiter({
  limit: CONFIG.auth.loginRateLimit.loginPerIpPerMinute,
  globalLimit: CONFIG.auth.loginRateLimit.loginGlobalPerMinute
});

router.get('/password', pageLimiter, async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const whose = token ? await passwordLinkService.peek(token) : null;
  if (!whose) return sendPage(res, { kind: 'invalid' });
  return sendPage(res, { kind: 'form', token, email: whose.email });
});

router.post('/password', setLimiter, async (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const confirm = typeof req.body?.password_confirm === 'string' ? req.body.password_confirm : '';
  const whose = token ? await passwordLinkService.peek(token) : null;
  if (!whose) return sendPage(res, { kind: 'invalid' });
  if (password !== confirm) {
    return sendPage(res, { kind: 'form', token, email: whose.email, error: 'The two passwords differ.', status: 400 });
  }
  try {
    const { email } = await passwordLinkService.redeem({ token, password });
    return sendPage(res, { kind: 'done', email });
  } catch (error) {
    if (error instanceof UserServiceError) {
      if (error.code === 'invalid_link') return sendPage(res, { kind: 'invalid' });
      return sendPage(res, { kind: 'form', token, email: whose.email, error: error.message, status: error.status });
    }
    logger.error({ err: error }, 'set password by link failed');
    return sendPage(res, { kind: 'invalid', status: 500 });
  }
});

type Page =
  | { kind: 'form'; token: string; email: string; error?: string; status?: number }
  | { kind: 'done'; email: string }
  | { kind: 'invalid'; status?: number };

function sendPage(res: Response, page: Page) {
  const title = page.kind === 'form' ? 'Set your password' : page.kind === 'done' ? 'Password set' : 'This link is not valid';
  const body =
    page.kind === 'form'
      ? `<h1>Set your password</h1>
  <p class="who">for <strong>${escapeHtml(page.email)}</strong></p>
  ${page.error ? `<p class="error" role="alert">${escapeHtml(page.error)}</p>` : ''}
  <form method="post" action="/password" autocomplete="on">
    <input type="hidden" name="token" value="${escapeHtml(page.token)}">
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="${CONFIG.auth.password.minLength}" required autofocus>
    <label for="password_confirm">Once more</label>
    <input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password" minlength="${CONFIG.auth.password.minLength}" required>
    <button type="submit">Set password</button>
  </form>
  <p class="hint">At least ${CONFIG.auth.password.minLength} characters. This link works once and then expires.</p>`
      : page.kind === 'done'
        ? `<h1>Password set</h1>
  <p>The password for <strong>${escapeHtml(page.email)}</strong> is set. You can sign in with it now; this link no longer works.</p>`
        : `<h1>This link is not valid</h1>
  <p>It was used, it expired, or it never was one. Ask the person who sent it for a new link.</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { width: min(22rem, calc(100vw - 3rem)); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .who { margin: 0 0 1.5rem; color: GrayText; }
  .hint { margin: 1rem 0 0; color: GrayText; font-size: .85rem; }
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
  ${body}
</main>
</body>
</html>`;
  return res
    .status(page.kind === 'invalid' ? (page.status ?? 404) : page.kind === 'form' ? (page.status ?? 200) : 200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    })
    .send(html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default router;
