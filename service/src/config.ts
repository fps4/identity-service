import dotenv from 'dotenv';

dotenv.config();

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOrigins = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const CONFIG = {
  environment: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 7305),
  mongo: {
    uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017',
    dbName: process.env.MONGO_DB_NAME ?? 'core-auth'
  },
  auth: {
    sessionTtlMinutes: toNumber(process.env.SESSION_TTL_MINUTES, 15),
    jwtSecret: process.env.AUTH_JWT_SECRET ?? '',
    jwtIssuer: process.env.AUTH_JWT_ISSUER ?? 'core-auth-service',
    jwtAudience: process.env.AUTH_JWT_AUDIENCE ?? 'core-auth-clients'
  },
  cors: {
    staticOrigins: parseOrigins(process.env.CORS_ORIGINS),
    allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS']
  },
  corsRefreshIntervalMs: toNumber(process.env.TENANT_CORS_REFRESH_INTERVAL_MS, 5 * 60 * 1000)
} as const;

export default CONFIG;
