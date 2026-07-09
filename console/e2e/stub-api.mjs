// A tiny stub of the /admin/v1 management plane for the Playwright smoke (RQ-0008). It serves just
// enough for the dashboard, applications, users, invites, and audit screens to render — and it asserts
// the request arrived with the operator's Bearer token (proving the console forwards it — ADR-0010).
// No persistence. Started by playwright.config.ts as a webServer.

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 7399);

const STATS = {
  clients: { total: 3 },
  users: { total: 5, locked: 0, disabled: 1 },
  tokens: { accessLastHour: 4, accessLastDay: 42, activeRefresh: 7 },
  keys: { active: 1 },
  at: new Date(0).toISOString(),
};
const AUDIT = [
  { _id: 'a1', at: new Date(0).toISOString(), action: 'user.create', principalSubject: 'operator@fps4.nl', targetId: 'u1', status: 200 },
];
// In-memory stores (one shared user pool — no tenant) so the directories and create flows have
// something to render.
const CLIENTS = [{ _id: 'c1', name: 'existing-svc', grantTypes: ['client_credentials'], scopes: ['admin'] }];
const USERS = [{ _id: 'u1', email: 'user@acme.com', status: 'active', roles: ['member'], identities: [{ provider: 'google', subject: 'g-seed-1', email: 'user@acme.com', emailVerified: true }] }];
const INVITES = [];

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  // The console must forward a Bearer token (the seeded operator JWT). Reject if missing.
  const auth = req.headers['authorization'] ?? '';
  if (!auth.startsWith('Bearer ')) return send(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname.replace(/^\/admin\/v1/, '');
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/stats') return send(res, 200, STATS);
  if (method === 'GET' && path === '/audit') return send(res, 200, { entries: AUDIT });

  // --- Directory reads ---
  if (method === 'GET' && path === '/clients') return send(res, 200, { clients: CLIENTS });
  if (method === 'GET' && path === '/users') return send(res, 200, { users: USERS });
  if (method === 'GET' && path === '/invites') return send(res, 200, { invites: INVITES });

  // --- Mutations ---
  let m;
  if (method === 'POST' && path === '/clients') {
    const body = await readBody(req);
    const id = `new-${CLIENTS.length + 1}`;
    CLIENTS.push({ _id: id, name: body.name, grantTypes: body.grantTypes ?? [], scopes: body.scopes ?? [] });
    return send(res, 201, { clientId: id, secret: 'stub-secret-shown-once-deadbeef' });
  }
  if (method === 'POST' && (m = path.match(/^\/clients\/([^/]+)\/rotate-secret$/))) {
    return send(res, 200, { clientId: m[1], secret: 'stub-secret-rotated-00000000' });
  }
  if (method === 'DELETE' && (m = path.match(/^\/clients\/([^/]+)$/))) {
    return send(res, 200, { clientId: m[1], deleted: true });
  }
  if (method === 'POST' && path === '/users') {
    const body = await readBody(req);
    USERS.push({ _id: 'nu', email: body.email, status: 'active', roles: body.roles ?? [], identities: [] });
    return send(res, 201, { id: 'nu', email: body.email });
  }
  if (method === 'POST' && path === '/users/link-identity') {
    const body = await readBody(req);
    const u = USERS.find((x) => x.email === body.email);
    if (!u) return send(res, 404, { error: 'user_not_found', error_description: 'User not found' });
    (u.identities ??= []).push({ provider: 'google', subject: body.subject, email: body.identityEmail, emailVerified: !!body.emailVerified });
    return send(res, 200, { email: body.email, provider: 'google', subject: body.subject, linked: true });
  }
  if (method === 'POST' && path === '/users/unlink-identity') {
    const body = await readBody(req);
    const u = USERS.find((x) => x.email === body.email);
    if (!u) return send(res, 404, { error: 'user_not_found', error_description: 'User not found' });
    u.identities = (u.identities ?? []).filter((i) => !(i.provider === 'google' && i.subject === body.subject));
    return send(res, 200, { email: body.email, provider: 'google', subject: body.subject, unlinked: true });
  }
  if (method === 'POST' && path === '/invites') {
    const body = await readBody(req);
    const id = `inv-${INVITES.length + 1}`;
    const expiresAt = new Date(Date.now() + (body.expiresInHours ?? 168) * 3600_000).toISOString();
    INVITES.push({
      _id: id, email: body.email ?? null, roles: body.roles ?? [],
      maxUses: body.maxUses ?? 1, usedCount: 0, expiresAt, note: body.note, status: 'pending'
    });
    return send(res, 201, { inviteId: id, code: 'STUB-C0DE-SH0W', expiresAt });
  }
  if (method === 'POST' && (m = path.match(/^\/invites\/([^/]+)\/revoke$/))) {
    const inv = INVITES.find((i) => i._id === m[1]);
    if (inv) inv.status = 'revoked';
    return send(res, 200, { inviteId: m[1], revoked: true });
  }

  return send(res, 404, { error: 'not_found' });
});

server.listen(port, () => console.log(`stub /admin/v1 on :${port}`));
