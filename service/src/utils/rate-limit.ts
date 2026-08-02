import type { Request, Response, NextFunction } from 'express';
import { extractClientMeta } from './request-metadata.js';

/**
 * A small in-process sliding-window rate limiter for the **public, unauthenticated** endpoints.
 *
 * Hand-rolled for the same reason the registration cap (`users.ts`) and the token cap (`oauth/server.ts`)
 * are: the limits this service needs are small and well understood, and an IdP pays for every runtime
 * dependency it puts on its own auth path.
 *
 * Two limits, because either alone is weak:
 *   - **per key** (client IP) — stops one source hammering the endpoint, but the key comes from
 *     `x-forwarded-for`, which a caller can spoof (this app sets no `trust proxy`), so a determined
 *     attacker rotates it freely;
 *   - **global** — a ceiling on the endpoint as a whole, which spoofing cannot route around. This is the
 *     same shape as the deployment-wide `registrationsPerMinute` cap.
 *
 * Deliberate limits of this thing, so nobody mistakes it for more than it is: the window lives in
 * process memory, so it is per-container and resets on restart — right for a single-container
 * deployment, not a distributed limiter. It is an **abuse and DoS guard, not an authorization
 * control**; the per-account lockout in the local IdP remains what stops targeted brute force.
 */

const DEFAULT_WINDOW_MS = 60_000;

/** Ceiling on tracked keys, so spraying a fresh spoofed IP per request cannot grow the map unbounded. */
const MAX_KEYS = 10_000;

export interface RateLimiterOptions {
  /** Max requests per key (client IP) within the window. */
  limit: number;
  /** Max requests across ALL keys within the window — the spoof-proof ceiling. */
  globalLimit: number;
  windowMs?: number;
  /** Injectable clock; tests drive the window without waiting on real time. */
  now?: () => number;
}

export function createRateLimiter(opts: RateLimiterOptions) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();
  let global: number[] = [];

  const prune = (times: number[], cutoff: number): number[] => {
    // Timestamps are appended in order, so the first in-window entry bounds the rest.
    const first = times.findIndex((t) => t > cutoff);
    return first === -1 ? [] : (first === 0 ? times : times.slice(first));
  };

  function sweep(cutoff: number): void {
    for (const [key, times] of hits) {
      const kept = prune(times, cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  function reject(res: Response, oldest: number, at: number): void {
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'slow_down', error_description: 'Too many requests, retry shortly' });
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const at = now();
    const cutoff = at - windowMs;

    global = prune(global, cutoff);
    if (global.length >= opts.globalLimit) {
      return reject(res, global[0], at);
    }

    const key = extractClientMeta(req).ip || 'unknown';
    let times = prune(hits.get(key) ?? [], cutoff);
    if (times.length >= opts.limit) {
      return reject(res, times[0], at);
    }

    if (!hits.has(key) && hits.size >= MAX_KEYS) {
      // Reclaim expired keys first; if the map is still full of live ones, drop the oldest-inserted so
      // the limiter degrades by forgetting history rather than by failing open or refusing everyone.
      sweep(cutoff);
      while (hits.size >= MAX_KEYS) {
        const oldest = hits.keys().next();
        if (oldest.done) break;
        hits.delete(oldest.value);
      }
    }

    times = [...times, at];
    hits.set(key, times);
    global = [...global, at];
    next();
  };
}
