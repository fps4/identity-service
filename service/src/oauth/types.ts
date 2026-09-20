import type { Logger } from '../utils/logger.js';
import type { Store } from '../db/index.js';
import type { GoogleIdp } from './google.js';
import type { RecordConfig } from '../record/outbox.js';

export interface OAuthServerDependencies {
  /** The table (ADR-0023). Injectable so tests drive the server over a table of their own. */
  store: Store;
  // The upstream Google OIDC adapter. Injectable so tests drive the flow with a stub (no network).
  googleIdp?: GoogleIdp;
  now?: () => Date;
  logger?: Logger;
  /**
   * maestro's record (ADR-0022). When present every token carries the principal's `prn` claim and a
   * first federated login registers the person on the record. The container always wires it; it is
   * optional only so a unit test can drive a grant without the registry.
   */
  record?: RecordConfig;
}

export interface ClientCredentialsInput {
  clientId: string;
  clientSecret: string;
  scope?: string[];
  subject?: string;
  sessionId?: string;
  /**
   * RFC 8707 resource indicator — the protected resource the token is for. When present and recognized,
   * the minted token's `aud` is bound to it (audience-binding, ADR-0009 Phase 2), so a token issued for
   * one resource cannot be replayed at another. An unrecognized resource is rejected (`invalid_target`).
   */
  resource?: string;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  scope: string[];
}

// --- User login flow (Authorization Code + PKCE; RQ-0001 Google SSO or RQ-0002 local credentials) ---

export interface StartAuthorizationInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string; // only 'S256' is supported
  state?: string;               // the consumer's opaque state, echoed back
  scope?: string[];
  /**
   * RFC 8707 resource indicator — the protected resource the eventual token is for. When present and
   * recognized, the token's `aud` is bound to it (ADR-0009 Phase 2) rather than to the application
   * default; this is how an MCP client obtains a token its resource server will accept. An
   * unrecognized resource is rejected (`invalid_target`).
   */
  resource?: string;
}

/**
 * Where the browser goes next. The deployment's IdP decides which:
 *   - `redirect` — hand the person to the upstream provider (Google, RQ-0001).
 *   - `login`    — this service authenticates them itself against the local-credential IdP
 *                  (RQ-0002); the caller renders a login form carrying `loginToken`.
 * A union rather than optional fields so a caller cannot forget to handle one leg.
 */
export type StartAuthorizationResult =
  | { mode: 'redirect'; redirectTo: string }
  | {
    mode: 'login';
    loginToken: string;
    /** The consumer's pre-registered redirect target. The login page must name it in its CSP
     *  `form-action`, because a redirect that RESULTS from a form submission is checked against that
     *  directive — omit it and the browser silently refuses to deliver the OAuth callback. */
    redirectUri: string;
  };

export interface LocalLoginInput {
  loginToken: string; // single-use handle for the pending authorization, issued with the form
  email: string;
  password: string;
}

export interface LocalLoginResult {
  // Where to 302 the browser back to the consumer, carrying our single-use code + the echoed state.
  redirectTo: string;
}

export interface HandleCallbackInput {
  code: string;   // Google's authorization code
  state: string;  // our googleState, matched against the stored authorization record
}

export interface HandleCallbackResult {
  // Where to 302 the browser back to the consumer, carrying our single-use code + the echoed state.
  redirectTo: string;
}

export interface AuthorizationCodeInput {
  code: string;          // our authorization code
  codeVerifier: string;  // PKCE verifier, hashed and matched against the stored challenge
  clientId: string;
  redirectUri: string;
  /** RFC 8707 resource indicator, repeated at the exchange. Must match the one the authorization
   *  request named — a mismatch is rejected rather than quietly re-targeting the token. */
  resource?: string;
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
}

export interface PasswordGrantInput {
  username: string;   // the user's email
  password: string;
  clientId: string;
}

export interface RevokeTokenInput {
  token: string;        // a refresh token; revokes it and its session
}

export interface UserTokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  scope: string[];
}
