/**
 * The abuse guard on the unauthenticated browser-login endpoints (`utils/rate-limit.ts`).
 *
 * The per-IP window is the first line, but `x-forwarded-for` is caller-controlled — this app sets no
 * `trust proxy` — so the global ceiling is what actually holds when someone rotates the header. Both are
 * exercised here, along with the window sliding open again.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createRateLimiter } from '../src/utils/rate-limit.js';

/** Mount a limiter on a trivial route with a clock the test drives. */
async function withApp(
  opts: { limit: number; globalLimit: number },
  run: (call: (ip?: string) => Promise<Response>, advance: (ms: number) => void) => Promise<void>
) {
  let clock = 1_000_000;
  const app = express();
  app.get('/x', createRateLimiter({ ...opts, now: () => clock }), (_req, res) => { res.json({ ok: true }); });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  try {
    await run(
      (ip = '203.0.113.9') => fetch(`${base}/x`, { headers: { 'x-forwarded-for': ip } }),
      (ms) => { clock += ms; }
    );
  } finally {
    server.close();
  }
}

describe('rate limiter', () => {
  it('allows requests up to the per-IP limit and refuses the next one', async () => {
    await withApp({ limit: 3, globalLimit: 1000 }, async (call) => {
      for (let i = 0; i < 3; i++) expect((await call()).status).toBe(200);

      const blocked = await call();
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ error: 'slow_down' });
    });
  });

  it('tells the caller when to come back', async () => {
    await withApp({ limit: 1, globalLimit: 1000 }, async (call) => {
      await call();
      const blocked = await call();

      expect(blocked.headers.get('retry-after')).toBe('60');
    });
  });

  it('lets the caller through again once the window slides past', async () => {
    await withApp({ limit: 2, globalLimit: 1000 }, async (call, advance) => {
      await call();
      await call();
      expect((await call()).status).toBe(429);

      advance(60_001);
      expect((await call()).status).toBe(200);
    });
  });

  it('counts each source address separately', async () => {
    await withApp({ limit: 1, globalLimit: 1000 }, async (call) => {
      expect((await call('198.51.100.1')).status).toBe(200);
      expect((await call('198.51.100.1')).status).toBe(429);
      expect((await call('198.51.100.2')).status).toBe(200); // a different caller is unaffected
    });
  });

  it('holds the line when a caller rotates the spoofable forwarded-for header', async () => {
    // Per-IP is generous, global is tight: rotating the header evades the first and hits the second.
    await withApp({ limit: 50, globalLimit: 4 }, async (call) => {
      for (let i = 0; i < 4; i++) {
        expect((await call(`198.51.100.${i}`)).status).toBe(200);
      }
      expect((await call('198.51.100.99')).status).toBe(429);
    });
  });

  it('reopens the global ceiling as its window slides too', async () => {
    await withApp({ limit: 50, globalLimit: 2 }, async (call, advance) => {
      await call('198.51.100.1');
      await call('198.51.100.2');
      expect((await call('198.51.100.3')).status).toBe(429);

      advance(60_001);
      expect((await call('198.51.100.4')).status).toBe(200);
    });
  });
});
