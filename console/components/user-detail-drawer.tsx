'use client';

// The per-user detail drawer (RQ-0014, ADR-0014). Opened from a row in the users directory, it shows
// the user's identity summary and routes every mutation through the SAME audited server actions the
// tenant-detail page uses (reset password, disable/enable, unlock, delete, link/unlink identity) — so
// this is presentation-only, with the per-actor audit (ADR-0010) unchanged. Actions revalidate
// `/users`, which restreams fresh props to the directory; a deleted user drops out and the parent
// unmounts this drawer.

import { ActionForm } from '@/components/action-form';
import { Field, Hidden } from '@/components/field';
import { Badge } from '@/components/ui/badge';
import { isLocked, statusLabel, statusTone } from '@/lib/users';
import {
  resetPassword, setUserStatus, unlockUser, deleteUser, linkIdentity, unlinkIdentity,
} from '@/app/actions';
import type { User } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function UserDetailDrawer({ user, tenantId, tenantName, onClose }: {
  user: User;
  tenantId: string;
  tenantName: string;
  onClose: () => void;
}) {
  const status = statusLabel(user);
  const locked = isLocked(user);
  const disabled = user.status === 'disabled';
  const identities = user.identities ?? [];
  const hasGoogle = identities.some((i) => i.provider === 'google');

  return (
    <div role="dialog" aria-modal="true" aria-label={`User ${user.email}`} className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l bg-background shadow-lg">
        {/* Header */}
        <div className="flex items-start gap-3 border-b p-5">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold">
            {user.email.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold">{user.email}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{user._id}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-auto p-5 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge tone={statusTone(status)} dot>{cap(status)}</Badge>
            {hasGoogle ? <Badge tone="info">Google SSO</Badge> : <Badge tone="neutral">Local password</Badge>}
            {user.emailVerified ? <Badge tone="success">Email verified</Badge> : null}
          </div>

          <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
            <dt className="text-muted-foreground">Tenant</dt>
            <dd>{tenantName} <span className="font-mono text-xs text-muted-foreground">{tenantId}</span></dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-mono text-xs">{user._id}</dd>
            <dt className="text-muted-foreground">Roles</dt>
            <dd>
              {user.roles?.length
                ? user.roles.map((r) => <span key={r} className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-xs">{r}</span>)
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Failed attempts</dt>
            <dd>
              {user.failedAttempts ?? 0}
              {locked && user.lockedUntil ? ` · locked until ${new Date(user.lockedUntil).toLocaleString()}` : ''}
            </dd>
          </dl>

          {/* Linked identities (RQ-0011) */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked identities</h3>
            {identities.length ? (
              <ul className="space-y-2">
                {identities.map((idn) => (
                  <li key={`${idn.provider}:${idn.subject}`} className="flex items-center gap-2">
                    <span className="font-mono text-xs" title={idn.email ?? undefined}>{idn.provider}:{idn.subject}</span>
                    <span className={idn.emailVerified ? 'text-xs text-green-600' : 'text-xs text-muted-foreground'} title={idn.emailVerified ? 'email verified' : 'email unverified'}>
                      {idn.emailVerified ? '✓' : '?'}
                    </span>
                    <ActionForm action={unlinkIdentity} submitLabel="Unlink" variant="outline" confirm={`Unlink ${idn.provider}:${idn.subject} from ${user.email}?`} inline>
                      <Hidden name="tenantId" value={tenantId} />
                      <Hidden name="email" value={user.email} />
                      <Hidden name="subject" value={idn.subject} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">None linked.</p>
            )}
            <div className="mt-2">
              <ActionForm action={linkIdentity} submitLabel="Link Google" variant="outline" inline>
                <Hidden name="tenantId" value={tenantId} />
                <Hidden name="email" value={user.email} />
                <Field name="subject" label="" placeholder="google sub" required />
              </ActionForm>
            </div>
          </section>

          {/* Reset password */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reset password</h3>
            <ActionForm action={resetPassword} submitLabel="Reset password" variant="outline">
              <Hidden name="tenantId" value={tenantId} />
              <Hidden name="email" value={user.email} />
              <Field name="password" label="New password" type="password" required />
            </ActionForm>
          </section>
        </div>

        {/* Footer — lifecycle actions */}
        <div className="flex flex-wrap items-center gap-2 border-t p-4">
          {locked && (
            <ActionForm action={unlockUser} submitLabel="Unlock" variant="outline" inline>
              <Hidden name="tenantId" value={tenantId} />
              <Hidden name="email" value={user.email} />
            </ActionForm>
          )}
          <ActionForm
            action={setUserStatus}
            submitLabel={disabled ? 'Enable account' : 'Disable account'}
            variant={disabled ? 'secondary' : 'outline'}
            confirm={disabled ? undefined : `Disable ${user.email}? They can no longer obtain tokens (existing sessions expire normally).`}
            inline
          >
            <Hidden name="tenantId" value={tenantId} />
            <Hidden name="email" value={user.email} />
            <Hidden name="status" value={disabled ? 'active' : 'disabled'} />
          </ActionForm>
          <div className="ml-auto">
            <ActionForm action={deleteUser} submitLabel="Delete" variant="destructive" confirm={`Delete ${user.email}? This is permanent.`} inline>
              <Hidden name="tenantId" value={tenantId} />
              <Hidden name="email" value={user.email} />
            </ActionForm>
          </div>
        </div>
      </aside>
    </div>
  );
}
