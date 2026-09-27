/**
 * The person's own routes (maestro ADR-0029): `/v1/me/preferences/:application` — what an application
 * wants to show them first. Called with the person's own access token, for that person only: the token
 * is verified against this service's own keys, and a machine token (`cid`) is refused, since it names no
 * person. Any application's user token will do — the document is the person's, namespaced by application.
 *
 * Not the registry: a preference authorises nothing and is not recorded on maestro's spine (ADR-0022
 * records acts on users, credentials and assignments). Not in the admin plane either — it is not an
 * operator's to see.
 */
import express, { type Request, type Response } from 'express';
import type { JWTPayload } from 'jose';
import type { Store } from '../db/index.js';
import type { UserDocument } from '../models/index.js';
import { bearerToken } from '../core/own-token.js';
import logger from '../utils/logger.js';

/** A preferences document is small by design: filters and pins, never data (ADR-0029). */
export const PREFERENCES_MAX_BYTES = 8 * 1024;

const APPLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MeRouterDependencies {
  store: Store;
  verifyToken: (token: string) => Promise<JWTPayload>;
  now?: () => Date;
}

type Refusal = { refused: true; status: number; error: string; description: string };

const refuse = (res: Response, r: Refusal) => res.status(r.status).json({ error: r.error, error_description: r.description });

export function createMeRouter(deps: MeRouterDependencies) {
  const router = express.Router();
  const now = deps.now ?? (() => new Date());

  /**
   * The person the token names. A local login's `sub` is the user's id; a federated login's is the
   * provider's subject, resolved through the user's linked identity — the same person either way.
   */
  async function person(req: Request): Promise<UserDocument | Refusal> {
    const token = bearerToken(req.headers.authorization);
    if (!token) return { refused: true, status: 401, error: 'unauthorized', description: 'Bearer token required' };
    let claims: JWTPayload;
    try {
      claims = await deps.verifyToken(token);
    } catch (err) {
      logger.warn({ err }, 'me: token verification failed');
      return { refused: true, status: 401, error: 'unauthorized', description: 'Invalid or expired token' };
    }
    if (typeof claims.cid === 'string' || typeof claims.sub !== 'string') {
      return { refused: true, status: 403, error: 'forbidden', description: 'A machine token names no person; preferences are a person\'s' };
    }
    const user = (await deps.store.users.get(claims.sub)) ?? (await deps.store.users.getByIdentity('google', claims.sub));
    if (!user || user.status === 'disabled') {
      return { refused: true, status: 403, error: 'forbidden', description: 'The token names no active user of this realm' };
    }
    return user;
  }

  /** The application must be one this realm knows: a preference for nothing is refused, not stored. */
  async function application(req: Request): Promise<string | Refusal> {
    const id = req.params.application ?? '';
    if (!APPLICATION_ID.test(id) || !(await deps.store.applications.get(id))) {
      return { refused: true, status: 404, error: 'not_found', description: `No application '${id}' in this realm` };
    }
    return id;
  }

  router.get('/preferences/:application', async (req: Request, res: Response) => {
    const who = await person(req);
    if ('refused' in who) return refuse(res, who);
    const app = await application(req);
    if (typeof app !== 'string') return refuse(res, app);
    const doc = await deps.store.preferences.get(who._id, app);
    res.set('Cache-Control', 'no-store');
    return res.json(doc?.preferences ?? {});
  });

  router.put('/preferences/:application', async (req: Request, res: Response) => {
    const who = await person(req);
    if ('refused' in who) return refuse(res, who);
    const app = await application(req);
    if (typeof app !== 'string') return refuse(res, app);
    const body: unknown = req.body;
    if (!req.is('application/json') || typeof body !== 'object' || body === null || Array.isArray(body)) {
      return refuse(res, { refused: true, status: 400, error: 'invalid_request', description: 'The body is a JSON object' });
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > PREFERENCES_MAX_BYTES) {
      return refuse(res, {
        refused: true,
        status: 413,
        error: 'too_large',
        description: `Preferences are at most ${PREFERENCES_MAX_BYTES} bytes; anything larger is data, not a preference`
      });
    }
    const preferences = body as Record<string, unknown>;
    await deps.store.preferences.put({ userId: who._id, applicationId: app, preferences, updatedAt: now() });
    res.set('Cache-Control', 'no-store');
    return res.json(preferences);
  });

  return router;
}
