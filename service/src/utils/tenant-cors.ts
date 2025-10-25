import { makeModels } from '../models/index.js';
import { getMasterConnection } from './db.js';
import logger from './logger.js';

const tenantOrigins = new Set<string>();
let refreshTimer: NodeJS.Timeout | undefined;

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function isTenantOriginAllowed(origin: string): boolean {
  return tenantOrigins.has(origin);
}

export function hasTenantOrigins(): boolean {
  return tenantOrigins.size > 0;
}

export async function refreshTenantOrigins(): Promise<void> {
  try {
    const conn = await getMasterConnection();
    const { Tenant } = makeModels(conn);

    const docs = await Tenant.find({}, { allowedOrigins: 1 }).lean().exec();

    const next = new Set<string>();
    for (const doc of docs) {
      const origins = Array.isArray((doc as any).allowedOrigins) ? (doc as any).allowedOrigins : [];
      for (const origin of origins) {
        const normalized = normalizeOrigin(origin);
        if (normalized) next.add(normalized);
      }
    }

    tenantOrigins.clear();
    for (const origin of next) tenantOrigins.add(origin);

    logger.info({ count: tenantOrigins.size }, 'tenant CORS origins refreshed');
  } catch (error) {
    logger.error({ err: error }, 'failed to refresh tenant CORS origins');
  }
}

function startRefreshTimer(intervalMs: number): void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshTenantOrigins().catch((error) => {
      logger.error({ err: error }, 'periodic tenant CORS refresh failed');
    });
  }, intervalMs);
  refreshTimer.unref();
}

export function scheduleTenantCorsRefresh(intervalMs: number): void {
  startRefreshTimer(intervalMs);
}
