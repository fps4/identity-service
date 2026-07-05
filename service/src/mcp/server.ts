/**
 * MCP management server — the **stdio transport** (ADR-0007, scoped by ADR-0011). A thin wrapper that
 * reads newline-delimited JSON-RPC 2.0 from stdin, dispatches each message through the transport-agnostic
 * core ({@link handleRpc} in `./handler.ts`), and writes the response to stdout. All tool logic, the scope
 * gate, and the audit trail live in the handler, shared with the forthcoming Streamable HTTP transport
 * (ADR-0009). The agent that runs this process must hold an admin credential and pass its access token as
 * IDENTITY_SERVICE_ADMIN_TOKEN; the token is verified once at startup and its scopes gate each tool call.
 *
 * Run: `IDENTITY_SERVICE_ADMIN_TOKEN=<access-token> npm run mcp`
 */
import { createInterface } from 'readline';
import { verifyAdminToken, type AdminPrincipal } from '../core/admin-auth.js';
import { disconnect } from '../utils/db.js';
import logger from '../utils/logger.js';
import { handleRpc } from './handler.js';

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function main(): Promise<void> {
  const token = process.env.IDENTITY_SERVICE_ADMIN_TOKEN ?? '';
  if (!token) {
    logger.error('IDENTITY_SERVICE_ADMIN_TOKEN is required to run the MCP management server');
    process.exit(1);
  }
  let principal: AdminPrincipal;
  try {
    principal = await verifyAdminToken(token);
  } catch (err) {
    logger.error({ err }, 'admin token rejected — cannot start MCP server');
    process.exit(1);
    return;
  }
  logger.info({ clientId: principal.clientId, scopes: principal.scopes }, 'MCP management server ready');

  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try { msg = JSON.parse(trimmed); } catch { return; }

    const response = await handleRpc(msg, principal);
    if (response) send(response);
  });

  const shutdown = async () => { await disconnect().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'MCP server crashed');
  process.exit(1);
});
