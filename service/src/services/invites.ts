// Invite-code primitives (RQ-0013, ADR-0013): generation, canonicalization, digesting, and status
// derivation. Pure (no I/O) — creation/listing lives in the admin service, redemption in the user
// service; both share these so a code digests identically wherever it is touched.
import { randomBytes } from 'crypto';
import { sha256Hex } from '../utils/hash.js';

// No 0/O/1/I — codes get read aloud and retyped from an email. 32 chars = 5 bits each; 12 chars =
// 60 bits of CSPRNG entropy, the ADR-0013 floor the unsalted-digest storage depends on. The 256 % 32
// modulo is exact, so byte→char mapping carries no bias.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const GROUP_LEN = 4;

/** Mint a humane show-once invite code, e.g. `V7QK-3MHP-XA2D`. */
export function generateInviteCode(): string {
  const bytes = randomBytes(CODE_GROUPS * GROUP_LEN);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_LEN; i++) {
      group += CODE_ALPHABET[bytes[g * GROUP_LEN + i] % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/**
 * Digest a presented code for storage/lookup. Canonicalizes first (uppercase, alphanumerics only)
 * so `v7qk3mhpxa2d` and `V7QK-3MHP-XA2D` redeem the same invite — dashes and case are for humans.
 */
export function inviteCodeDigest(code: string): string {
  return sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

export type InviteStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

/** Derive the admin-plane status. Revocation wins over exhaustion wins over expiry. */
export function deriveInviteStatus(
  invite: { usesRemaining: number; expiresAt: Date; revokedAt?: Date | null },
  now: Date
): InviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.usesRemaining <= 0) return 'redeemed';
  if (invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
