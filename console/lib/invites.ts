import type { Invite } from '@/lib/api';

// Presentation helper shared by the invites directory and its drawer (RQ-0017). Kept out of the
// server-only lib/api so client components can use it (the `import type` is erased at build).

export type InviteStatus = Invite['status'];

/** Badge tone for an invite's derived status (pending / redeemed / expired / revoked). */
export function inviteStatusTone(s: InviteStatus): 'info' | 'success' | 'warning' | 'neutral' {
  switch (s) {
    case 'pending': return 'info';
    case 'redeemed': return 'success';
    case 'revoked': return 'warning';
    default: return 'neutral'; // expired
  }
}
