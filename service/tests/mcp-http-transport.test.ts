import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'crypto';
import { SignJWT } from 'jose';
import express from 'express';
import type { Server } from 'http';

// Verify admin tokens against a known test key (same pattern as admin-api.test.ts).
const { privateKey: testPrivateKeyPem, publicKey: testPublicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const testJwk = createPublicKey(testPublicKeyPem).export({ format: 'jwk' }) as Record<string, string>;

vi.mock('../src/utils/key-store.js', () => ({
  listPublicKeys: vi.fn(async () => [{ kid: 'test-kid', kty: 'RSA', alg: 'RS256', use: 'sig', n: testJwk.n, e: testJwk.e }]),
  rotateSigningKey: vi.fn(async () => ({ kid: 'rotated-kid', privateKeyPem: '', publicKeyPem: '' }))
}));

import { createMcpRouter, protectedResourceMetadata, authorizationServerMetadata } from '../src/mcp/http-transport.js';
import { CONFIG } from '../src/config.js';

const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })
    .setIssuer(CONFIG.auth.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(createPrivateKey(testPrivateKeyPem));

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get('/.well-known/oauth-protected-resource', (_req, res) => { res.json(protectedResourceMetadata()); });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => { res.json(authorizationServerMetadata()); });
  app.use('/mcp', createMcpRouter());
  return app;
}

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = makeApp().listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});
afterAll(() => { server?.close(); });

async function rpc(token: string | null, body: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

describe('MCP HTTP transport (ADR-0009 Phase 1) — discovery metadata', () => {
  it('protected-resource metadata points at the authorization server', () => {
    const m = protectedResourceMetadata();
    expect(m.resource).toBe(CONFIG.mcp.resourceUrl);
    expect(m.authorization_servers).toEqual([CONFIG.auth.jwtIssuer]);
  });

  it('authorization-server metadata exposes the token endpoint + JWKS', () => {
    const m = authorizationServerMetadata();
    expect(m.issuer).toBe(CONFIG.auth.jwtIssuer);
    expect(m.token_endpoint).toBe(`${CONFIG.auth.jwtIssuer}/oauth2/token`);
    expect(m.jwks_uri).toBe(`${CONFIG.auth.jwtIssuer}/.well-known/jwks.json`);
    expect(m.grant_types_supported).toContain('client_credentials');
  });
});

describe('MCP HTTP transport — authentication', () => {
  it('challenges an unauthenticated POST with a discovery-bearing WWW-Authenticate (401)', async () => {
    const r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/Bearer resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
  });

  it('rejects a valid token that lacks any admin scope (403 insufficient_scope)', async () => {
    const token = await sign({ cid: 'runtime-x' }); // machine token, no scope
    const r = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('insufficient_scope');
  });
});

describe('MCP HTTP transport — JSON-RPC over POST', () => {
  it('initialize returns serverInfo for an admin-scoped token', async () => {
    const token = await sign({ cid: 'admin-client', scope: 'admin' });
    const r = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(r.status).toBe(200);
    expect(r.json.result.serverInfo.name).toBe('identity-service-admin');
    expect(r.json.result.protocolVersion).toBe('2025-03-26');
  });

  it('tools/list works for a granular admin scope and lists the operational tools', async () => {
    const token = await sign({ cid: 'agent', scope: 'admin:users' });
    const r = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.status).toBe(200);
    const names = r.json.result.tools.map((t: any) => t.name);
    expect(names).toContain('rotate_client_secret');
    expect(names).not.toContain('create_client');
  });

  it('a notification (no id) is accepted with 202 and no body', async () => {
    const token = await sign({ cid: 'admin-client', scope: 'admin' });
    const r = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.json).toBeNull();
  });

  it('a malformed request body is a -32600 error (400)', async () => {
    const token = await sign({ cid: 'admin-client', scope: 'admin' });
    const r = await rpc(token, { not: 'json-rpc' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
  });
});

describe('MCP HTTP transport — GET', () => {
  it('returns 405 (no server-initiated SSE stream) for an authenticated GET', async () => {
    const token = await sign({ cid: 'admin-client', scope: 'admin' });
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
