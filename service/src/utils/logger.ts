import pino, { type Logger as PinoLogger } from 'pino';

const shouldPrettyPrint = (() => {
  const flag = process.env.LOG_PRETTY?.toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return process.env.NODE_ENV !== 'production';
})();

/**
 * Which fd the logs go to. Stdout by default, but the **stdio MCP transport**
 * (`src/mcp/server.ts`) runs with LOG_DESTINATION=stderr: there fd 1 carries the JSON-RPC
 * stream, so a log line interleaved into it is a protocol violation — a lenient client skips
 * the non-conforming message, a strict one errors on it. Every module logs through this one
 * shared instance (db, admin-auth, the MCP handler), so the switch has to be process-wide;
 * swapping the logger inside the entrypoint alone would still leak the startup lines.
 */
const destination = process.env.LOG_DESTINATION?.toLowerCase() === 'stderr' ? 2 : 1;

const level = process.env.LOG_LEVEL ?? 'info';

export const logger: PinoLogger = shouldPrettyPrint
  ? pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', destination }
      }
    })
  : pino({ level }, pino.destination({ dest: destination, sync: true }));

export type Logger = typeof logger;

export default logger;
