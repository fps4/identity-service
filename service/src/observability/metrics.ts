// Golden-signal collection for this service's own runtime health. An Express middleware times every
// request into a rolling window, and `snapshot()` rolls that window up into request rate, error rate,
// latency percentiles and a coarse error map, plus liveness derived from the Mongo connection. No
// content and no per-request retention beyond the window — just bounded counters and durations.
//
// This used to speak maestro's heartbeat/telemetry wire contract (US-0070/US-0076) and shipped the
// rollup outbound over the managed-product SDK. The shape here is now our own: the numbers are the
// same, but they are camelCase, flat, and surfaced through /admin/v1/stats rather than pushed to a
// downstream service — identity-service is upstream of its consumers and does not depend on them.

import type { RequestHandler } from 'express';
import os from 'os';

interface Sample {
  t: number;
  durationMs: number;
  status: number;
}

/** Self-assessed liveness for one rollup. */
export type RuntimeStatus = 'ok' | 'degraded' | 'down';

export interface MetricsRecorderOptions {
  /** Rolling window the rollup covers, in ms. Defaults to 60s. */
  windowMs?: number;
  /** Hard cap on retained samples so a traffic spike cannot grow memory unbounded. */
  maxSamples?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Whether the critical dependency (Mongo) is currently usable. Drives `down` status. */
  dependencyHealthy?: () => boolean;
  /** Injectable process-uptime seconds (tests). Defaults to `process.uptime`. */
  uptimeSeconds?: () => number;
}

/** The bounded golden signals for one window. Latency percentiles are absent on an empty window. */
export interface RuntimeSignals {
  windowSeconds: number;
  requestRate: number;
  errorRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  p99LatencyMs?: number;
  memoryPct: number;
  uptimeSeconds: number;
  /** Coarse, enum-keyed counts (`4xx`/`5xx`) — omitted entirely when the window is clean. */
  errors?: Record<string, number>;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  signals: RuntimeSignals;
}

/** error_rate at/above which we self-report `degraded` (with enough samples to be meaningful). */
const DEGRADED_ERROR_RATE = 0.5;
const MIN_SAMPLES_FOR_DEGRADED = 5;

export class MetricsRecorder {
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly now: () => number;
  private readonly dependencyHealthy: () => boolean;
  private readonly uptimeSecondsFn: () => number;
  private samples: Sample[] = [];

  constructor(opts: MetricsRecorderOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxSamples = opts.maxSamples ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.dependencyHealthy = opts.dependencyHealthy ?? (() => true);
    this.uptimeSecondsFn = opts.uptimeSeconds ?? (() => process.uptime());
  }

  /** Record one completed request. Public for tests; the middleware calls it on `res.finish`. */
  record(durationMs: number, status: number): void {
    this.samples.push({ t: this.now(), durationMs, status });
    this.prune();
  }

  /** Express middleware: stopwatch each request, recording its duration + final status code. */
  get middleware(): RequestHandler {
    return (_req, res, next) => {
      const start = this.now();
      res.on('finish', () => this.record(this.now() - start, res.statusCode));
      next();
    };
  }

  /** Drop samples older than the window and enforce the hard cap (oldest-first). */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    if (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples = this.samples.filter((s) => s.t >= cutoff);
    }
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(this.samples.length - this.maxSamples);
    }
  }

  /** Roll the current window up into a status + golden-signal snapshot. */
  snapshot(): RuntimeSnapshot {
    this.prune();
    const window = this.samples;
    const count = window.length;
    const windowSeconds = this.windowMs / 1000;

    let n4xx = 0;
    let n5xx = 0;
    for (const s of window) {
      if (s.status >= 500) n5xx += 1;
      else if (s.status >= 400) n4xx += 1;
    }

    const durations = window.map((s) => s.durationMs).sort((a, b) => a - b);
    const requestRate = round(count / windowSeconds, 4);
    const errorRate = count > 0 ? round(n5xx / count, 4) : 0;

    const errors: Record<string, number> = {};
    if (n4xx > 0) errors['4xx'] = n4xx;
    if (n5xx > 0) errors['5xx'] = n5xx;

    const signals: RuntimeSignals = {
      windowSeconds,
      requestRate,
      errorRate,
      p50LatencyMs: percentile(durations, 0.5),
      p95LatencyMs: percentile(durations, 0.95),
      p99LatencyMs: percentile(durations, 0.99),
      memoryPct: round((process.memoryUsage().rss / os.totalmem()) * 100, 2),
      uptimeSeconds: Math.round(this.uptimeSecondsFn()),
      ...(Object.keys(errors).length > 0 ? { errors } : {})
    };

    return { status: this.status(count, errorRate), signals };
  }

  private status(count: number, errorRate: number): RuntimeStatus {
    if (!this.dependencyHealthy()) return 'down';
    if (count >= MIN_SAMPLES_FOR_DEGRADED && errorRate >= DEGRADED_ERROR_RATE) return 'degraded';
    return 'ok';
  }
}

/** Nearest-rank percentile of an ascending-sorted array. `undefined` for an empty window (omit it). */
function percentile(sortedAsc: number[], q: number): number | undefined {
  const n = sortedAsc.length;
  if (n === 0) return undefined;
  const rank = Math.ceil(q * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
