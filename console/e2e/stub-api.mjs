// A tiny stub of the /admin/v1 management plane for the Playwright smoke (RQ-0008). It serves just
// enough for the dashboard, applications, credentials, users, invites, and audit screens to render — and
// it asserts the request arrived with the operator's Bearer token (proving the console forwards it —
// ADR-0010). No persistence. Started by playwright.config.ts as a webServer.

import { createServer } from 'node:http';

const port = Number(process.argv[2] || 7399);

const STATS = {
  applications: { total: 1 },
  clients: { total: 3 },
  users: { total: 5, locked: 0, disabled: 1 },
  assignments: { active: 2 },
  tokens: { accessLastHour: 4, accessLastDay: 42, activeRefresh: 7 },
  keys: { active: 1 },
  at: new Date(0).toISOString(),
};
const AUDIT = [
  { _id: 'a1', at: new Date(0).toISOString(), action: 'user.create', principalSubject: 'operator@fps4.nl', targetId: 'u1', status: 200 },
];
// In-memory stores (ADR-0018 shared user pool + ADR-0020 applications own the role catalogue/members;
// credentials are leaves under an application) so the directories and management flows have something to
// render.
const APPLICATIONS = [{ _id: 'app1', name: 'existing-product', audience: 'existing-product', roles: [{ key: 'admin', name: 'Admin' }, { key: 'member', name: 'Member' }] }];
const CLIENTS = [{ _id: 'c1', applicationId: 'app1', name: 'existing-svc', grantTypes: ['client_credentials'], scopes: ['admin'] }];
const USERS = [{ _id: 'u1', email: 'user@acme.com', status: 'active', identities: [{ provider: 'google', subject: 'g-seed-1', email: 'user@acme.com', emailVerified: true }] }];
const INVITES = [];
// Assignments: { email, applicationId, status, roles }. One seeded so the members/assignments views render.
const ASSIGNMENTS = [{ email: 'user@acme.com', applicationId: 'app1', status: 'active', roles: ['member'] }];

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
  if (method === 'GET' && path === '/applications') return send(res, 200, { applications: APPLICATIONS });
  if (method === 'GET' && path === '/clients') {
    const applicationId = url.searchParams.get('applicationId');
    const clients = applicationId ? CLIENTS.filter((c) => c.applicationId === applicationId) : CLIENTS;
    return send(res, 200, { clients });
  }
  if (method === 'GET' && path === '/users') return send(res, 200, { users: USERS });
  if (method === 'GET' && path === '/invites') return send(res, 200, { invites: INVITES });

  let m;

  // --- Applications (ADR-0020): the product-level registration ---
  if (method === 'GET' && (m = path.match(/^\/applications\/([^/]+)$/))) {
    const app = APPLICATIONS.find((a) => a._id === m[1]);
    return app ? send(res, 200, app) : send(res, 404, { error: 'application_not_found' });
  }
  if (method === 'POST' && path === '/applications') {
    const body = await readBody(req);
    const id = body.id || `app-${APPLICATIONS.length + 1}`;
    APPLICATIONS.push({ _id: id, name: body.name, audience: body.audience, roles: body.roles ?? [] });
    return send(res, 201, { applicationId: id });
  }
  if (method === 'DELETE' && (m = path.match(/^\/applications\/([^/]+)$/))) {
    if (CLIENTS.some((c) => c.applicationId === m[1])) {
      return send(res, 409, { error: 'application_has_credentials', error_description: 'Delete its credentials first' });
    }
    const i = APPLICATIONS.findIndex((a) => a._id === m[1]);
    if (i >= 0) APPLICATIONS.splice(i, 1);
    return send(res, 200, { applicationId: m[1], deleted: true });
  }
  if (method === 'GET' && (m = path.match(/^\/applications\/([^/]+)\/roles$/))) {
    const app = APPLICATIONS.find((a) => a._id === m[1]);
    return send(res, 200, { roles: app?.roles ?? [] });
  }
  if (method === 'PUT' && (m = path.match(/^\/applications\/([^/]+)\/roles$/))) {
    const body = await readBody(req);
    const app = APPLICATIONS.find((a) => a._id === m[1]);
    if (app) app.roles = body.roles ?? [];
    return send(res, 200, { roles: body.roles ?? [] });
  }
  if (method === 'GET' && (m = path.match(/^\/applications\/([^/]+)\/members$/))) {
    const members = ASSIGNMENTS.filter((a) => a.applicationId === m[1]).map((a) => {
      const u = USERS.find((x) => x.email === a.email);
      return { userId: u?._id ?? a.email, email: a.email, userStatus: u?.status, status: a.status, roles: a.roles };
    });
    return send(res, 200, { members });
  }
  if (method === 'GET' && (m = path.match(/^\/applications\/([^/]+)\/credentials$/))) {
    return send(res, 200, { clients: CLIENTS.filter((c) => c.applicationId === m[1]) });
  }

  // --- Per-user assignments (ADR-0020) ---
  if (method === 'GET' && path === '/assignments') {
    const email = url.searchParams.get('email') ?? '';
    const assignments = ASSIGNMENTS.filter((a) => a.email === email).map((a) => ({
      applicationId: a.applicationId, applicationName: APPLICATIONS.find((app) => app._id === a.applicationId)?.name, status: a.status, roles: a.roles,
    }));
    return send(res, 200, { assignments });
  }
  if (method === 'POST' && path === '/assignments') {
    const body = await readBody(req);
    const existing = ASSIGNMENTS.find((a) => a.email === body.email && a.applicationId === body.applicationId);
    if (existing) { existing.roles = body.roles ?? []; existing.status = 'active'; }
    else ASSIGNMENTS.push({ email: body.email, applicationId: body.applicationId, status: 'active', roles: body.roles ?? [] });
    return send(res, 201, { email: body.email, applicationId: body.applicationId, roles: body.roles ?? [], status: 'active' });
  }
  if (method === 'POST' && path === '/assignments/update') {
    const body = await readBody(req);
    const a = ASSIGNMENTS.find((x) => x.email === body.email && x.applicationId === body.applicationId);
    if (!a) return send(res, 404, { error: 'assignment_not_found', error_description: 'No such assignment' });
    if (Array.isArray(body.roles)) a.roles = body.roles;
    if (body.status) a.status = body.status;
    return send(res, 200, { email: a.email, applicationId: a.applicationId, roles: a.roles, status: a.status });
  }
  if (method === 'POST' && path === '/assignments/revoke') {
    const body = await readBody(req);
    const i = ASSIGNMENTS.findIndex((x) => x.email === body.email && x.applicationId === body.applicationId);
    if (i >= 0) ASSIGNMENTS.splice(i, 1);
    return send(res, 200, { email: body.email, applicationId: body.applicationId, revoked: true });
  }

  // --- Mutations ---
  if (method === 'POST' && path === '/clients') {
    const body = await readBody(req);
    const id = `new-${CLIENTS.length + 1}`;
    CLIENTS.push({ _id: id, applicationId: body.applicationId, name: body.name, grantTypes: body.grantTypes ?? [], scopes: body.scopes ?? [] });
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
    USERS.push({ _id: 'nu', email: body.email, status: 'active', identities: [] });
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
      _id: id, applicationId: body.applicationId, email: body.email ?? null, roles: body.roles ?? [],
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
