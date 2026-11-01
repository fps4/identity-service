import { describe, it, expect } from 'vitest';
import { openIdConfiguration } from '../src/oauth/discovery.js';
import { authorizationServerMetadata } from '../src/mcp/http-transport.js';
import { CONFIG } from '../src/config.js';

// API Gateway's JWT authorizer (and any generic OIDC verifier) finds the issuer's keys only through
// <issuer>/.well-known/openid-configuration, whose `issuer` must equal the tokens' `iss` exactly.
describe('OIDC discovery', () => {
  it('names the issuer the tokens carry and the JWKS that verifies them', () => {
    const doc = openIdConfiguration();
    expect(doc.issuer).toBe(CONFIG.auth.jwtIssuer);
    expect(doc.jwks_uri).toBe(`${CONFIG.auth.jwtIssuer}/.well-known/jwks.json`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('carries the fields the discovery format requires', () => {
    const doc = openIdConfiguration();
    for (const field of ['issuer', 'authorization_endpoint', 'jwks_uri', 'response_types_supported', 'subject_types_supported', 'id_token_signing_alg_values_supported']) {
      expect(doc).toHaveProperty(field);
    }
  });

  it('agrees with the RFC 8414 metadata on every endpoint both publish', () => {
    const oidc = openIdConfiguration();
    const as = authorizationServerMetadata();
    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri'] as const) {
      expect(oidc[k]).toBe(as[k]);
    }
  });

  it('advertises public clients with PKCE', () => {
    const doc = openIdConfiguration();
    expect(doc.token_endpoint_auth_methods_supported).toContain('none');
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
  });
});
