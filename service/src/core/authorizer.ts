import type {
  Authorizer,
  AuthorizerDependencies,
  CreateSessionInput,
  CreateSessionResult,
  UpdateSessionInput,
  UpdateSessionResult,
  ClientMeta
} from './types.js';
import {
  InvalidInputError,
  SessionNotFoundError,
  NoSessionUpdatesProvidedError
} from './errors.js';

export function createAuthorizer(deps: AuthorizerDependencies): Authorizer {
  const uuid = deps.uuid ?? randomUuid;
  const now = deps.now ?? (() => new Date());
  const ttlMinutes = Number(deps.sessionTtlMinutes);

  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new InvalidInputError('sessionTtlMinutes must be a positive number');
  }

  async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const visitorId = input.visitorId ? String(input.visitorId) : uuid();
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60 * 1000);

    deps.logger?.info?.({ client: input.clientMeta }, 'auth request received');

    const connection = await deps.getMasterConnection();
    const { Session } = deps.makeModels(connection);

    if (typeof Session.init === 'function') {
      await Session.init();
    }

    const sessionId = uuid();
    const context = buildSessionContext(input.clientMeta);
    await Session.create({
      _id: sessionId,
      visitorId,
      status: 'active',
      context,
      createdAt: issuedAt,
      updatedAt: issuedAt,
      expiresAt
    });

    deps.logger?.info?.({ sessionId }, 'session created');

    const secondsUntilExpiry = Math.max(1, Math.floor((expiresAt.getTime() - issuedAt.getTime()) / 1000));
    const { token, exp } = await deps.signJwt({
      sessionId,
      subject: input.subject,
      expiresInSec: secondsUntilExpiry
    });
    const nowSeconds = Math.floor(issuedAt.getTime() / 1000);

    deps.logger?.info?.({ sessionId }, 'auth success');

    return {
      sessionId,
      visitorId,
      token,
      expiresIn: Math.max(0, exp - nowSeconds),
      expiresAt
    };
  }

  async function updateSession(input: UpdateSessionInput): Promise<UpdateSessionResult> {
    if (!input.sessionId) {
      throw new InvalidInputError('sessionId is required');
    }

    const connection = await deps.getMasterConnection();
    const { Session } = deps.makeModels(connection);

    const session = await Session.findById(input.sessionId).exec();
    if (!session) {
      throw new SessionNotFoundError(input.sessionId);
    }

    let modified = false;
    if (input.contactId) {
      (session as any).contactId = input.contactId;
      modified = true;
    }

    if (input.cookies && typeof input.cookies === 'object') {
      const context = ((session as any).context ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(input.cookies)) {
        if (key === 'session_id' || value == null) continue;
        context[key] = String(value);
        modified = true;
      }
      (session as any).context = context;
    }

    if (!modified) {
      throw new NoSessionUpdatesProvidedError();
    }

    const updatedAt = now();
    (session as any).updatedAt = updatedAt;
    await session.save();

    deps.logger?.info?.({ sessionId: input.sessionId }, 'session updated');

    return {
      sessionId: input.sessionId,
      updated: {
        contactId: (session as any).contactId ?? null,
        context: ((session as any).context ?? null) as Record<string, unknown> | null,
        updatedAt: (session as any).updatedAt as Date
      }
    };
  }

  return { createSession, updateSession };
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = Math.random() * 16 | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

function buildSessionContext(meta?: ClientMeta): Record<string, unknown> | undefined {
  if (!meta) return undefined;

  const context: Record<string, unknown> = {};
  const mappedEntries: Array<[keyof ClientMeta, string]> = [
    ['userAgent', 'user_agent'],
    ['chUa', 'ch_ua'],
    ['chUaPlatform', 'ch_ua_platform'],
    ['chUaMobile', 'ch_ua_mobile'],
    ['ip', 'ip_address']
  ];

  for (const [sourceKey, targetKey] of mappedEntries) {
    const raw = meta[sourceKey];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    context[targetKey] = value;
  }

  for (const [key, raw] of Object.entries(meta)) {
    if (mappedEntries.some(([sourceKey]) => sourceKey === key)) continue;
    if (raw === undefined || raw === null) continue;
    context[key] = raw;
  }

  return Object.keys(context).length ? context : undefined;
}
