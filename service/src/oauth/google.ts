import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { AccessDeniedError } from './errors.js';

/**
 * Upstream Google OIDC adapter (RQ-0001). Three concerns: build the authorize URL the browser is
 * redirected to, exchange Google's authorization code for an id_token, and verify that id_token
 * (signature via Google's JWKS, plus `iss` / `aud` / `exp` / `nonce`) into a stable identity.
 *
 * The whole adapter is an interface so the OAuth server can be driven by a stub in tests — no
 * network. The default implementation (`createGoogleIdp`) talks to the real Google endpoints.
 */
export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  redirectUri: string;
}

export interface GoogleAuthUrlArgs {
  state: string;
  nonce: string;
  scope?: string[];
}

export interface GoogleIdentity {
  email: string;
  sub: string;
  emailVerified: boolean;
}

export interface GoogleIdp {
  buildAuthorizationUrl(args: GoogleAuthUrlArgs): string;
  exchangeCode(code: string): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string, expected: { nonce: string }): Promise<GoogleIdentity>;
}

export interface CreateGoogleIdpOptions {
  fetchImpl?: typeof fetch;
  // The JWKS key resolver passed to jose's jwtVerify. Defaults to a remote set fetched from
  // `config.jwksUri`; tests inject a local key (or resolver) to verify without network.
  keyResolver?: JWTVerifyGetKey | KeyLike | Uint8Array;
}

const DEFAULT_SCOPE = ['openid', 'email', 'profile'];

export function createGoogleIdp(config: GoogleConfig, options: CreateGoogleIdpOptions = {}): GoogleIdp {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(new URL(config.jwksUri));

  return {
    buildAuthorizationUrl({ state, nonce, scope }) {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: (scope && scope.length ? scope : DEFAULT_SCOPE).join(' '),
        state,
        nonce
      });
      return `${config.authorizationEndpoint}?${params.toString()}`;
    },

    async exchangeCode(code) {
      if (!fetchImpl) {
        throw new Error('No fetch implementation available for Google token exchange');
      }
      const body = new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      });
      const response = await fetchImpl(config.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok || !data?.id_token) {
        throw new AccessDeniedError(`Google token exchange failed (${response.status})`);
      }
      return { idToken: data.id_token as string };
    },

    async verifyIdToken(idToken, expected) {
      let payload: Record<string, unknown>;
      try {
        // jwtVerify enforces the signature (via the JWKS `kid`), `iss`, `aud`, and `exp`.
        ({ payload } = await jwtVerify(idToken, keyResolver as JWTVerifyGetKey, {
          issuer: config.issuer,
          audience: config.clientId
        }));
      } catch (error: any) {
        throw new AccessDeniedError(`Google id_token verification failed: ${error?.message ?? 'invalid token'}`);
      }

      if (!payload.nonce || payload.nonce !== expected.nonce) {
        throw new AccessDeniedError('Google id_token nonce mismatch');
      }
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
      if (!email || !sub) {
        throw new AccessDeniedError('Google id_token missing email or sub');
      }
      return { email, sub, emailVerified: payload.email_verified === true };
    }
  };
}
