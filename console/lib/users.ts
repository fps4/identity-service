import type { User } from '@/lib/api';

// Presentation helpers shared by the users directory and the detail drawer (RQ-0014). Kept out of
// lib/api (which is `server-only`) so client components can use them; the `import type` above is
// erased at build, so pulling these in never drags the server-only client into the browser bundle.

export type UserStatus = 'active' | 'disabled' | 'locked';

/** A brute-force lockout is active while `lockedUntil` is still in the future. */
export function isLocked(u: Pick<User, 'lockedUntil'>): boolean {
  return !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
}

/** The single status we badge a user with — lockout takes precedence over the stored status. */
export function statusLabel(u: Pick<User, 'status' | 'lockedUntil'>): UserStatus {
  if (isLocked(u)) return 'locked';
  if (u.status === 'disabled') return 'disabled';
  return 'active';
}

export function statusTone(s: UserStatus): 'success' | 'warning' | 'neutral' {
  return s === 'locked' ? 'warning' : s === 'disabled' ? 'neutral' : 'success';
}
