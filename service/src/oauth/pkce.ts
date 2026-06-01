import { createHash } from 'crypto';

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge` (RFC 7636, S256 only).
 * `challenge` must equal BASE64URL(SHA256(verifier)). Plain method is intentionally unsupported.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  // Lengths are equal for any S256 challenge; a direct compare is sufficient (no secret material).
  return computed === codeChallenge;
}
