import { describe, it, expect, vi } from 'vitest';
import { handleRpc, TOOLS, SERVER_INFO, DEFAULT_PROTOCOL, type ToolDef, type HandlerDeps } from '../src/mcp/handler.js';
import type { AdminPrincipal } from '../src/core/admin-auth.js';

// Phase 0 (ADR-0009): the JSON-RPC core is transport-agnostic, so it can be exercised directly with
// injected deps — no stdio, no database. These tests pin the exact wire behaviour the stdio (and the
// forthcoming Streamable HTTP) transports rely on.

const admin: AdminPrincipal = { scopes: ['admin'], kind: 'machine', clientId: 'test-admin' };
const noScope: AdminPrincipal = { scopes: [], kind: 'machine', clientId: 'test-lowpriv' };

function fakeDeps(tool: ToolDef): HandlerDeps & { writeAudit: ReturnType<typeof vi.fn> } {
  const writeAudit = vi.fn(async () => {});
  return { tools: [tool], writeAudit };
}

const echoTool: ToolDef = {
  name: 'echo',
  description: 'echo',
  areaScope: 'admin:stats',
  inputSchema: {},
  handler: async (a) => ({ echoed: a })
};

describe('MCP handler — protocol dispatch', () => {
  it('initialize echoes the client protocol version + serverInfo', async () => {
    const res = await handleRpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, admin);
    expect(res).toMatchObject({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: SERVER_INFO }
    });
  });

  it('initialize falls back to the default protocol when none is given', async () => {
    const res = await handleRpc({ id: 1, method: 'initialize', params: {} }, admin);
    expect((res as any).result.protocolVersion).toBe(DEFAULT_PROTOCOL);
  });

  it('tools/list returns the catalogue and omits structural provisioning tools (ADR-0011)', async () => {
    const res = await handleRpc({ id: 2, method: 'tools/list' }, admin);
    const names = (res as any).result.tools.map((t: any) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names).toContain('rotate_client_secret');
    expect(names).not.toContain('create_client');
    expect(names).not.toContain('onboard_tenant');
    expect(names).not.toContain('delete_client');
  });

  it('ping returns an empty result', async () => {
    expect(await handleRpc({ id: 3, method: 'ping' }, admin)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  it('notifications/initialized produces no response', async () => {
    expect(await handleRpc({ method: 'notifications/initialized' }, admin)).toBeNull();
  });

  it('an unknown method with an id is a -32601 error; a notification (no id) is silent', async () => {
    expect(await handleRpc({ id: 9, method: 'no/such' }, admin)).toMatchObject({ id: 9, error: { code: -32601 } });
    expect(await handleRpc({ method: 'no/such' }, admin)).toBeNull();
  });
});

describe('MCP handler — tools/call', () => {
  it('unknown tool is a -32602 error', async () => {
    const res = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'nope' } }, admin, fakeDeps(echoTool));
    expect(res).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it('denies a caller lacking the tool scope and audits the denial', async () => {
    const deps = fakeDeps(echoTool);
    const res = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }, noScope, deps);
    expect((res as any).result.isError).toBe(true);
    expect((res as any).result.content[0].text).toMatch(/Forbidden/);
    expect(deps.writeAudit).toHaveBeenCalledWith(noScope, 'echo', false, { denied: 'insufficient_scope' });
  });

  it('runs the tool, returns its JSON result, and audits success', async () => {
    const deps = fakeDeps(echoTool);
    const res = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }, admin, deps);
    expect((res as any).result.isError).toBeUndefined();
    expect(JSON.parse((res as any).result.content[0].text)).toEqual({ echoed: { a: 1 } });
    expect(deps.writeAudit).toHaveBeenCalledWith(admin, 'echo', true);
  });

  it('surfaces a handler error as an isError result and audits the failure', async () => {
    const boom: ToolDef = { ...echoTool, handler: async () => { throw new Error('kaboom'); } };
    const deps = fakeDeps(boom);
    const res = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }, admin, deps);
    expect((res as any).result.isError).toBe(true);
    expect((res as any).result.content[0].text).toMatch(/kaboom/);
    expect(deps.writeAudit).toHaveBeenCalledWith(admin, 'echo', false, { error: 'kaboom' });
  });
});
