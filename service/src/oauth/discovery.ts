/**
 * OpenID Connect discovery (`/.well-known/openid-configuration`) for the user-login flows. A relying
 * party that verifies this service's tokens through a generic OIDC client finds the issuer and the
 * JWKS here — AWS API Gateway's JWT authorizer, for one, reads nothing else. Always served, unlike the
 * RFC 8414 document the MCP transport publishes for its own resource.
 *
 * The service issues access tokens only, no ID tokens: `id_token_signing_alg_values_supported` is
 * required by the discovery format and names the algorithm its tokens are signed with.
 */
import { CONFIG } from '../config.js';

export function openIdConfiguration() {
  const iss = CONFIG.auth.jwtIssuer;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth2/authorize`,
    token_endpoint: `${iss}/oauth2/token`,
    revocation_endpoint: `${iss}/oauth2/revoke`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'password', 'client_credentials'],
    // A public client (a browser app with PKCE) exchanges its code without a secret.
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  };
}
