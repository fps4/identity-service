'use client';

// Per-invite detail drawer (RQ-0017, ADR-0014). Opened from the invites directory. Shows the invite's
// binding/roles/usage/expiry and offers Revoke for a still-pending invite (the only mutation an invite
// supports), routed through the existing audited revokeInvite action. The code itself is never shown —
// it is show-once at creation only (ADR-0013).

import { Drawer } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Hidden } from '@/components/field';
import { revokeInvite } from '@/app/actions';
import { inviteStatusTone } from '@/lib/invites';
import type { Invite } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function InviteDetailDrawer({ invite, onClose }: {
  invite: Invite;
  onClose: () => void;
}) {
  return (
    <Drawer
      ariaLabel={`Invite ${invite._id}`}
      title={invite.email || 'Any email'}
      subtitle={invite._id}
      badges={<Badge tone={inviteStatusTone(invite.status)} dot>{cap(invite.status)}</Badge>}
      onClose={onClose}
      footer={
        invite.status === 'pending' ? (
          <div className="ml-auto">
            <ActionForm action={revokeInvite} submitLabel="Revoke invite" variant="destructive" confirm="Revoke this invite? Its code stops working immediately." inline>
              <Hidden name="inviteId" value={invite._id} />
            </ActionForm>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No actions — this invite is {invite.status}.</span>
        )
      }
    >
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Invite</h3>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">Bound to</dt>
          <dd>{invite.email || <span className="text-muted-foreground">any email</span>}</dd>
          <dt className="text-muted-foreground">Roles</dt>
          <dd>{invite.roles?.length ? invite.roles.map((r) => <span key={r} className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-xs">{r}</span>) : '—'}</dd>
          <dt className="text-muted-foreground">Uses</dt>
          <dd>{invite.usedCount} / {invite.maxUses}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{new Date(invite.expiresAt).toLocaleString()}</dd>
          {invite.note ? (<><dt className="text-muted-foreground">Note</dt><dd>{invite.note}</dd></>) : null}
          {invite.createdBy ? (<><dt className="text-muted-foreground">Created by</dt><dd className="font-mono text-xs">{invite.createdBy}</dd></>) : null}
        </dl>
      </div>
      <p className="text-xs text-muted-foreground">
        The code is shown once at creation and never stored in readable form (only a hash is kept). If it
        was lost, revoke this invite and create a new one.
      </p>
    </Drawer>
  );
}
