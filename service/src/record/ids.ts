/**
 * Identifier minting for maestro's record (ADR-0022).
 *
 * A maestro principal id carries its kind — `prn-h-…` human, `prn-a-…` agent, `prn-w-…` workload — so the
 * spine can tell a human from an agent by shape before it consults a registry, and so an agent in
 * `accountable` is refused at append. Lower-case Crockford base32 after the letter, which is what the
 * spine's grammar (`^prn-[haw]-[a-z0-9][a-z0-9._-]{0,62}$`) admits; the same alphabet and length
 * maestro-specs' `mintPrincipalId` used while it minted ids itself.
 */
import { randomBytes } from 'crypto';
import type { PrincipalKind } from '../models/principal.js';

/** Crockford base32 without I, L, O and U — no character pair reads alike out loud or in a font. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function token(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += ALPHABET[b % 32];
  return out;
}

const KIND_LETTER: Record<PrincipalKind, 'h' | 'a' | 'w'> = { human: 'h', agent: 'a', workload: 'w' };

export const mintPrincipalId = (kind: PrincipalKind): string => `prn-${KIND_LETTER[kind]}-${token(12)}`;

/** The kind a principal id claims by its letter; the registry says what it actually is. */
export function kindOfPrincipalId(id: string): PrincipalKind | undefined {
  const letter = id.slice(4, 5);
  return letter === 'h' ? 'human' : letter === 'a' ? 'agent' : letter === 'w' ? 'workload' : undefined;
}

/** The realm as a body token: the workspace id without its `ws-` prefix (`ws-identity-dev` → `identity-dev`). */
export const realmOf = (workspaceId: string): string => workspaceId.replace(/^ws-/, '');
