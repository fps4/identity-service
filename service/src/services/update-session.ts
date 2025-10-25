import type { Request } from 'express';
import {
  InvalidInputError,
  NoSessionUpdatesProvidedError,
  SessionNotFoundError
} from '../core/errors.js';
import { authorizer } from '../container.js';

type ExpressLike = Pick<Request, 'headers' | 'body' | 'params'> | Record<string, any>;

type ExpressStyleResponse = {
  status: number;
  json: () => { message?: string; sessionId?: string; updated?: unknown };
};

type LambdaStyleResponse = {
  statusCode: number;
  body: string;
};

export async function updateSession(reqOrEvent: ExpressLike): Promise<ExpressStyleResponse | LambdaStyleResponse> {
  const isExpress = !!reqOrEvent?.headers && typeof reqOrEvent.headers === 'object';

  let body: any = {};
  try {
    if (isExpress) {
      body = reqOrEvent.body || {};
    } else {
      body = typeof reqOrEvent.body === 'string' ? JSON.parse(reqOrEvent.body) : reqOrEvent.body || {};
    }
  } catch {
    return buildResponse(isExpress, 400, { message: 'Invalid JSON body' });
  }

  const sessionId = extractSessionId(reqOrEvent, body, isExpress);
  if (!sessionId) {
    return buildResponse(isExpress, 400, { message: 'Missing sessionId in path, body, or cookies' });
  }

  const contactId = body?.contactId ? String(body.contactId) : undefined;
  const cookies = body?.cookies && typeof body.cookies === 'object' ? body.cookies : undefined;

  try {
    const result = await authorizer.updateSession({
      sessionId,
      contactId,
      cookies
    });

    return buildResponse(isExpress, 200, { sessionId: result.sessionId, updated: result.updated });
  } catch (error: any) {
    if (error instanceof SessionNotFoundError) {
      return buildResponse(isExpress, 404, { message: 'Session not found' });
    }
    if (error instanceof NoSessionUpdatesProvidedError || error instanceof InvalidInputError) {
      return buildResponse(isExpress, 400, { message: error.message });
    }

    return buildResponse(isExpress, 500, { message: 'Internal Server Error' });
  }
}

function buildResponse(isExpress: boolean, status: number, payload: Record<string, unknown>) {
  if (isExpress) {
    return {
      status,
      json: () => payload as any
    } satisfies ExpressStyleResponse;
  }

  return {
    statusCode: status,
    body: JSON.stringify(payload)
  } satisfies LambdaStyleResponse;
}

function extractSessionId(reqOrEvent: ExpressLike, body: any, isExpress: boolean): string | undefined {
  if (isExpress) {
    return (
      reqOrEvent.params?.sessionId ||
      reqOrEvent.params?.session_id ||
      body?.sessionId ||
      body?.session_id ||
      body?.cookies?.sessionId ||
      body?.cookies?.session_id
    );
  }

  return (
    reqOrEvent.pathParameters?.sessionId ||
    reqOrEvent.pathParameters?.session_id ||
    body?.sessionId ||
    body?.session_id ||
    body?.cookies?.sessionId ||
    body?.cookies?.session_id
  );
}
