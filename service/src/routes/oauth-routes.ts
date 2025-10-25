import express from 'express';
import type { Request, Response } from 'express';
import { oauthServer } from '../container.js';
import {
  OAuthError,
  InvalidRequestError,
  InvalidClientError
} from '../oauth/errors.js';

const router = express.Router();

router.post('/token', async (req: Request, res: Response) => {
  const grantType = (req.body?.grant_type ?? req.query?.grant_type) as string | undefined;
  if (!grantType) {
    return handleError(res, new InvalidRequestError('grant_type is required'));
  }

  if (grantType !== 'client_credentials') {
    return handleError(res, new InvalidRequestError('Only client_credentials grant is supported'));
  }

  const credentials = extractClientCredentials(req);
  if (!credentials.clientId || !credentials.clientSecret) {
    return handleError(res, new InvalidClientError('Client credentials missing'));
  }

  const scopeParam = req.body?.scope ?? req.query?.scope;
  const scopes = typeof scopeParam === 'string' && scopeParam.trim()
    ? scopeParam.trim().split(/\s+/)
    : [];

  try {
    const token = await oauthServer.issueClientCredentialsToken({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      scope: scopes
    });

    return res.status(200).json({
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
      scope: token.scope.join(' ')
    });
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return handleError(res, error);
    }

    return res.status(500).json({
      error: 'server_error',
      error_description: 'Internal Server Error'
    });
  }
});

function handleError(res: Response, error: OAuthError) {
  const payload: Record<string, string> = {
    error: error.error,
    error_description: error.description ?? error.message
  };
  const headers: Record<string, string> = {};
  if (error instanceof InvalidClientError) {
    headers['WWW-Authenticate'] = 'Basic realm="oauth"';
  }
  return res.status(error.status).set(headers).json(payload);
}

function extractClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization ?? req.headers.Authorization;
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const value = header.slice('Basic '.length);
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    const [clientId, clientSecret] = decoded.split(':');
    return { clientId, clientSecret };
  }

  const clientId = req.body?.client_id ?? req.query?.client_id;
  const clientSecret = req.body?.client_secret ?? req.query?.client_secret;
  return { clientId, clientSecret };
}

export default router;
