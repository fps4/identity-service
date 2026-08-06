/**
 * The management plane carries the abuse guard, and carries it *in front of* the admin-token check.
 *
 * Ordering is the whole point. `requireAdmin` verifies an RS256 signature on every request, before any
 * principal exists — so a limiter mounted after it would only ever bound callers who already hold a valid
 * token, i.e. exactly the ones that were never the threat. These tests drive unauthenticated requests: a
 * `429` where a `401` would otherwise be is the proof the guard runs first.
 *
 * The limits come from env at module load, so this file sets them low and imports the router dynamically
 * — hence its own file rather than a case inside `admin-api.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// One limiter instance serves the whole file and its global window never resets mid-run, so the global
// ceiling is set well clear of what the per-IP cases spend — otherwise they'd trip the global limit and
// pass for the wrong reason. The last case then spends the rest of it deliberately.
const PER_IP = 4;
const GLOBAL = 20;

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.ADMIN_API_REQUESTS_PER_MINUTE = String(PER_IP);
  process.env.ADMIN_API_REQUESTS_GLOBAL_PER_MINUTE = String(GLOBAL);

  // Imported after the env is in place: CONFIG is read at module load, and the router builds its limiter
  // from CONFIG at import time.
  const { default: adminRoutes } = await import('../src/routes/admin-routes.js');
  const app = express();
  app.use(express.json());
  app.use('/admin/v1', adminRoutes);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  delete process.env.ADMIN_API_REQUESTS_PER_MINUTE;
  delete process.env.ADMIN_API_REQUESTS_GLOBAL_PER_MINUTE;
});

const call = (ip: string, path = '/admin/v1/applications') =>
  fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } });

describe('management plane abuse guard', () => {
  it('bounds an unauthenticated caller before the token check, then refuses with 429', async () => {
    const ip = '203.0.113.10';

    // Under the limit the request reaches `requireAdmin` and is refused for the real reason: no token.
    for (let i = 0; i < PER_IP; i++) {
      expect((await call(ip)).status).toBe(401);
    }

    // Over it, the limiter answers first — the signature check never runs.
    const blocked = await call(ip);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'slow_down' });
    expect(blocked.headers.get('retry-after')).toBeTruthy();
  });

  it('covers every route on the plane, not just the one that tripped it', async () => {
    // A different IP, a different route: the guard is mounted router-level, so a route added later is
    // covered by construction rather than by whoever adds it remembering to.
    const ip = '203.0.113.11';
    for (let i = 0; i < PER_IP; i++) {
      expect((await call(ip, '/admin/v1/users')).status).toBe(401);
    }
    expect((await call(ip, '/admin/v1/stats')).status).toBe(429);
  });

  it('holds the global ceiling when the per-IP key is rotated', async () => {
    // `x-forwarded-for` is caller-controlled (this app sets no `trust proxy`), so per-IP alone is defeated
    // by spraying a fresh header per request. One request per IP keeps every per-IP window at 1 — far
    // under PER_IP — so a 429 here can only have come from the global ceiling.
    const statuses: number[] = [];
    for (let i = 0; i < GLOBAL; i++) {
      statuses.push((await call(`198.51.100.${i}`)).status);
    }

    expect(statuses).toContain(429);
    expect(statuses.at(-1)).toBe(429); // once the ceiling is reached it stays shut for the window
  });
});
