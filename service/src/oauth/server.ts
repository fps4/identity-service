import { randomUUID } from 'crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { CONFIG } from '../config.js';
import type { OAuthServerDependencies, ClientCredentialsInput, TokenResponse } from './types.js';
import {
  InvalidClientError,
  UnauthorizedClientError,
  InvalidScopeError,
  InvalidRequestError,
  RateLimitExceededError
} from './errors.js';
import { verifySecret } from '../utils/hash.js';
import { getActiveKeyPair } from '../utils/key-store.js';
import type { TenantOAuthConfig } from '../models/tenant.js';

const GRANT_CLIENT_CREDENTIALS = 'client_credentials';

export function createOAuthServer(deps: OAuthServerDependencies) {
  const nowFn = deps.now ?? (() => new Date());

  async function issueClientCredentialsToken(input: ClientCredentialsInput): Promise<TokenResponse> {
    if (!input.clientId || !input.clientSecret) {
      throw new InvalidRequestError('client_id and client_secret are required');
    }

    const connection = await deps.getMasterConnection();
    const models = deps.makeModels(connection);

    const client = await models.OAuthClient.findById(input.clientId).lean().exec();
    if (!client) {
      throw new InvalidClientError('Client not found');
    }

    if (!client.isConfidential) {
      throw new UnauthorizedClientError('Client credentials grant requires confidential client');
    }

    if (!verifySecret(input.clientSecret, client.secretHash)) {
      throw new InvalidClientError('Client secret mismatch');
    }

    if (!client.grantTypes.includes(GRANT_CLIENT_CREDENTIALS)) {
      throw new UnauthorizedClientError('Grant type not allowed for client');
    }

    const tenantId = client.tenantId;
    const tenant = await models.Tenant.findOne({ _id: tenantId, status: 'active' }).lean().exec();
    if (!tenant) {
      throw new UnauthorizedClientError('Tenant inactive or missing');
    }

    const tenantOAuthConfig = ((tenant as unknown as { oauth?: TenantOAuthConfig })?.oauth) ?? undefined;
    if (!tenantOAuthConfig?.enabled) {
      throw new UnauthorizedClientError('Tenant not configured for OAuth');
    }

    const tenantGrantTypes = new Set(
      (tenantOAuthConfig.allowedGrantTypes && tenantOAuthConfig.allowedGrantTypes.length
        ? tenantOAuthConfig.allowedGrantTypes
        : [GRANT_CLIENT_CREDENTIALS]
      )
    );
    if (!tenantGrantTypes.has(GRANT_CLIENT_CREDENTIALS)) {
      throw new UnauthorizedClientError('Grant type not enabled for tenant');
    }

    const requestedScope = input.scope ?? [];
    let candidateScopes = requestedScope.length ? [...requestedScope] : [...(client.scopes ?? [])];
    if (!candidateScopes.length && CONFIG.oauth.defaultClientCredentialsScopes.length) {
      candidateScopes = [...CONFIG.oauth.defaultClientCredentialsScopes];
    }

    const allowedScopes = new Set(client.scopes ?? []);
    const tenantScopeAllowlist = tenantOAuthConfig.allowedScopes && tenantOAuthConfig.allowedScopes.length
      ? new Set(tenantOAuthConfig.allowedScopes)
      : null;
    const effectiveScopes: string[] = [];

    if (candidateScopes.length) {
      for (const scope of candidateScopes) {
        if (!allowedScopes.has(scope)) {
          throw new InvalidScopeError(`Scope ${scope} not permitted for client`);
        }
        if (tenantScopeAllowlist && !tenantScopeAllowlist.has(scope)) {
          throw new InvalidScopeError(`Scope ${scope} not permitted for tenant`);
        }
        if (!effectiveScopes.includes(scope)) {
          effectiveScopes.push(scope);
        }
      }
    } else if (tenantScopeAllowlist) {
      for (const scope of tenantScopeAllowlist) {
        if (allowedScopes.has(scope)) {
          effectiveScopes.push(scope);
        }
      }
    }

    for (const scope of effectiveScopes) {
      if (!allowedScopes.has(scope)) {
        throw new InvalidScopeError(`Scope ${scope} not permitted`);
      }
    }

    const issuedAt = nowFn();
    const tenantTokenLimit = tenantOAuthConfig.limits?.tokensPerMinute ?? CONFIG.oauth.tenantDefaults.maxAccessTokensPerMinute;
    await enforceRateLimit(models, tenantId, issuedAt, tenantTokenLimit);
    const expiresIn = CONFIG.oauth.accessTokenTtlSec;
    const expDate = new Date(issuedAt.getTime() + expiresIn * 1000);
    const jti = randomUUID();

    const keyPair = await getActiveKeyPair();
    const privateKey = await importPKCS8(keyPair.privateKeyPem, 'RS256');

    const payload: Record<string, unknown> = {
      tid: tenantId,
      cid: client._id,
      scope: effectiveScopes.join(' '),
      sub: input.subject ?? client._id
    };
    if (input.sessionId) {
      payload.sid = input.sessionId;
    }

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: keyPair.kid, typ: 'JWT' })
      .setIssuer(CONFIG.auth.jwtIssuer)
      .setAudience(CONFIG.auth.jwtAudience)
      .setJti(jti)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expDate.getTime() / 1000))
      .sign(privateKey);

    await models.OAuthToken.create({
      _id: jti,
      tenantId,
      clientId: client._id,
      subject: payload.sub,
      sessionId: input.sessionId,
      type: 'access',
      scope: effectiveScopes,
      expiresAt: expDate,
      issuedAt,
      status: 'active'
    });

    deps.logger?.info?.({ tenantId, clientId: client._id, scopes: effectiveScopes }, 'issued client credentials token');

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn,
      scope: effectiveScopes
    };
  }

  return {
    issueClientCredentialsToken
  };
}

async function enforceRateLimit(models: ReturnType<OAuthServerDependencies['makeModels']>, tenantId: string, issuedAt: Date, maxPerMinute: number) {
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
    return;
  }
  const windowStart = new Date(issuedAt.getTime() - 60 * 1000);
  const count = await models.OAuthToken.countDocuments({
    tenantId,
    type: 'access',
    issuedAt: { $gte: windowStart }
  }).exec();

  if (count >= maxPerMinute) {
    throw new RateLimitExceededError(60);
  }
}
