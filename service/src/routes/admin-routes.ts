import express from 'express';
import type { Request, Response } from 'express';
import { adminService } from '../container.js';
import { requireAdmin, ADMIN_SCOPES } from '../core/admin-auth.js';
import { AdminServiceError } from '../services/admin.js';
import { getMasterConnection } from '../utils/db.js';
import { makeModels } from '../models/index.js';
import logger from '../utils/logger.js';

const router = express.Router();

/** Append-only audit write (ADR-0007). Fire-and-forget after the response so it never blocks a call. */
function audit(req: Request, res: Response, action: string, target?: { type?: string; id?: string }, meta?: Record<string, unknown>): void {
  res.on('finish', () => {
    void (async () => {
      try {
        const models = makeModels(await getMasterConnection());
        await models.AuditLog.create({
          at: new Date(),
          principalClientId: req.admin?.clientId,
          principalSubject: req.admin?.subject,
          action,
          method: req.method,
          path: req.originalUrl,
          targetType: target?.type,
          targetId: target?.id,
          status: res.statusCode,
          meta
        });
      } catch (err) {
        logger.error({ err, action }, 'failed to write audit log');
      }
    })();
  });
}

function handleError(res: Response, error: unknown): Response {
  if (error instanceof AdminServiceError) {
    return res.status(error.status).json({ error: error.code, error_description: error.message });
  }
  logger.error({ err: error }, 'admin route error');
  return res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
}

// --- Clients ---

router.get('/clients', requireAdmin(ADMIN_SCOPES.clients), async (_req, res) => {
  try {
    res.json({ clients: await adminService.listClients() });
  } catch (e) { handleError(res, e); }
});

router.post('/clients', requireAdmin(ADMIN_SCOPES.clients), async (req, res) => {
  try {
    const result = await adminService.createClient(req.body ?? {});
    audit(req, res, 'client.create', { type: 'client', id: result.clientId });
    // The secret is returned ONCE — only its hash is persisted.
    res.status(201).json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/clients/:id/rotate-secret', requireAdmin(ADMIN_SCOPES.clients), async (req, res) => {
  try {
    const result = await adminService.rotateClientSecret(req.params.id);
    audit(req, res, 'client.rotateSecret', { type: 'client', id: req.params.id });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.delete('/clients/:id', requireAdmin(ADMIN_SCOPES.clients), async (req, res) => {
  try {
    const result = await adminService.deleteClient(req.params.id);
    audit(req, res, 'client.delete', { type: 'client', id: req.params.id });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

// --- Application role catalogue (ADR-0019) ---

router.get('/clients/:id/roles', requireAdmin(ADMIN_SCOPES.clients), async (req, res) => {
  try {
    res.json({ roles: await adminService.getClientRoles(req.params.id) });
  } catch (e) { handleError(res, e); }
});

router.put('/clients/:id/roles', requireAdmin(ADMIN_SCOPES.clients), async (req, res) => {
  try {
    const roles = await adminService.setClientRoles(req.params.id, req.body?.roles ?? []);
    audit(req, res, 'client.setRoles', { type: 'client', id: req.params.id }, { roles: roles.map((r) => r.key) });
    res.json({ roles });
  } catch (e) { handleError(res, e); }
});

// The users assigned to an application, with their app-scoped roles.
router.get('/clients/:id/members', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    res.json({ members: await adminService.listClientMembers(req.params.id) });
  } catch (e) { handleError(res, e); }
});

// --- Users ---

router.get('/users', requireAdmin(ADMIN_SCOPES.users), async (_req, res) => {
  try {
    res.json({ users: await adminService.listUsers() });
  } catch (e) { handleError(res, e); }
});

router.post('/users', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const result = await adminService.createUser(req.body ?? {});
    audit(req, res, 'user.create', { type: 'user', id: result.id });
    res.status(201).json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/users/reset-password', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    await adminService.resetUserPassword(email, password);
    audit(req, res, 'user.resetPassword', { type: 'user', id: email });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

router.post('/users/status', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, status } = req.body ?? {};
    if (status !== 'active' && status !== 'disabled') {
      return res.status(400).json({ error: 'invalid_input', error_description: "status must be 'active' or 'disabled'" });
    }
    await adminService.setUserStatus(email, status);
    audit(req, res, 'user.setStatus', { type: 'user', id: email }, { status });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

router.post('/users/unlock', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email } = req.body ?? {};
    await adminService.unlockUser(email);
    audit(req, res, 'user.unlock', { type: 'user', id: email });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

router.post('/users/link-identity', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, provider, subject, identityEmail, emailVerified } = req.body ?? {};
    const result = await adminService.linkUserIdentity(email, { provider, subject, identityEmail, emailVerified });
    audit(req, res, 'user.linkIdentity', { type: 'user', id: email }, { provider, subject });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/users/unlink-identity', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, provider, subject } = req.body ?? {};
    const result = await adminService.unlinkUserIdentity(email, { provider, subject });
    audit(req, res, 'user.unlinkIdentity', { type: 'user', id: email }, { provider, subject });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/users/delete', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email } = req.body ?? {};
    const result = await adminService.deleteUser(email);
    audit(req, res, 'user.delete', { type: 'user', id: email });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

// --- Invites (RQ-0013) ---

router.post('/invites', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const result = await adminService.createInvite({
      ...(req.body ?? {}),
      createdBy: req.admin?.subject ?? req.admin?.clientId
    });
    audit(req, res, 'invite.create', { type: 'invite', id: result.inviteId }, { maxUses: req.body?.maxUses });
    // The code is returned ONCE — only its digest is persisted.
    res.status(201).json(result);
  } catch (e) { handleError(res, e); }
});

router.get('/invites', requireAdmin(ADMIN_SCOPES.users), async (_req, res) => {
  try {
    res.json({ invites: await adminService.listInvites() });
  } catch (e) { handleError(res, e); }
});

router.post('/invites/:id/revoke', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const result = await adminService.revokeInvite(req.params.id);
    audit(req, res, 'invite.revoke', { type: 'invite', id: req.params.id });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

// --- Assignments (ADR-0019): a user's entitlement + app-scoped roles for an application ---

// A user's applications: GET /assignments?email=<email>
router.get('/assignments', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email : '';
    if (!email) return res.status(400).json({ error: 'invalid_input', error_description: 'email query param is required' });
    res.json({ assignments: await adminService.listUserAssignments(email) });
  } catch (e) { handleError(res, e); }
});

router.post('/assignments', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, clientId, roles } = req.body ?? {};
    const result = await adminService.assignUser({ email, clientId, roles, createdBy: req.admin?.subject ?? req.admin?.clientId });
    audit(req, res, 'assignment.create', { type: 'assignment', id: `${email}@${clientId}` }, { email, clientId, roles });
    res.status(201).json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/assignments/update', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, clientId, roles, status } = req.body ?? {};
    const result = await adminService.updateAssignment(email, clientId, { roles, status });
    audit(req, res, 'assignment.update', { type: 'assignment', id: `${email}@${clientId}` }, { roles, status });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.post('/assignments/revoke', requireAdmin(ADMIN_SCOPES.users), async (req, res) => {
  try {
    const { email, clientId } = req.body ?? {};
    const result = await adminService.revokeAssignment(email, clientId);
    audit(req, res, 'assignment.revoke', { type: 'assignment', id: `${email}@${clientId}` }, { email, clientId });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

// --- Signing keys ---

router.post('/keys/rotate', requireAdmin(ADMIN_SCOPES.keys), async (req, res) => {
  try {
    const result = await adminService.rotateKey();
    audit(req, res, 'key.rotate', { type: 'key', id: result.kid });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.get('/keys', requireAdmin(ADMIN_SCOPES.keys), async (_req, res) => {
  try {
    res.json({ keys: await adminService.keyStatus() });
  } catch (e) { handleError(res, e); }
});

// --- Statistics + audit log (console dashboards) ---

router.get('/stats', requireAdmin(ADMIN_SCOPES.stats), async (_req, res) => {
  try {
    res.json(await adminService.getStats());
  } catch (e) { handleError(res, e); }
});

router.get('/audit', requireAdmin(ADMIN_SCOPES.stats), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const models = makeModels(await getMasterConnection());
    const entries = await models.AuditLog.find().sort({ at: -1 }).limit(limit).lean().exec();
    res.json({ entries });
  } catch (e) { handleError(res, e); }
});

export default router;
