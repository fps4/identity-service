import pino from 'pino';

const shouldPrettyPrint = (() => {
  const flag = process.env.LOG_PRETTY?.toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return process.env.NODE_ENV !== 'production';
})();

const transport = shouldPrettyPrint
  ? {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' }
    }
  : undefined;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport
});

export type Logger = typeof logger;

export default logger;
