'use client';

// The data-first users directory (RQ-0014, ADR-0014): tenant picker + client-side search/status
// filter + a table with status badges, opening a per-user detail drawer. Replaces the old form-first
// /users page. The server component loads one tenant's users; filtering here never refetches. Every
// mutation runs through the existing audited server actions (in the drawer and the create dialog).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Table, THead, TBody } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Field, Hidden } from '@/components/field';
import { UserDetailDrawer } from '@/components/user-detail-drawer';
import { statusLabel, statusTone } from '@/lib/users';
import { createUser } from '@/app/actions';
import type { User } from '@/lib/api';

type TenantOption = { _id: string; name: string };
type StatusFilter = 'all' | 'active' | 'disabled' | 'locked';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const inputCls =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function UsersDirectory({ tenants, activeTenantId, users, loadError }: {
  tenants: TenantOption[];
  activeTenantId: string;
  users: User[];
  loadError?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeTenant = tenants.find((t) => t._id === activeTenantId);
  const tenantName = activeTenant?.name ?? activeTenantId;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (status !== 'all' && statusLabel(u) !== status) return false;
      if (q && !u.email.toLowerCase().includes(q) && !u._id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, query, status]);

  // Bind the drawer to the freshest record each render; if the user was deleted it becomes null and
  // the drawer unmounts.
  const selected = selectedId ? users.find((u) => u._id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Tenant"
          value={activeTenantId}
          onChange={(e) => router.push(`/users?tenantId=${encodeURIComponent(e.target.value)}`)}
          className={inputCls}
        >
          {tenants.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
        </select>
        <input
          aria-label="Search users"
          placeholder="Search email or subject…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={inputCls}>
          <option value="all">Any status</option>
          <option value="active">Active</option>
          <option value="locked">Locked</option>
          <option value="disabled">Disabled</option>
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} of {users.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>Create user</Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-destructive">Couldn’t load users: {loadError}</p>}

      <div className="rounded-lg border">
        <Table>
          <THead>
            <tr><th>User</th><th>Status</th><th>Roles</th><th>Sign-in</th><th className="w-0" /></tr>
          </THead>
          <TBody>
            {filtered.map((u) => {
              const s = statusLabel(u);
              const google = (u.identities ?? []).some((i) => i.provider === 'google');
              return (
                <tr key={u._id} onClick={() => setSelectedId(u._id)} className="cursor-pointer">
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
                        {u.email.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium">{u.email}</div>
                        <div className="font-mono text-xs text-muted-foreground">{u._id}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge tone={statusTone(s)} dot>{cap(s)}</Badge>
                    {s === 'locked' && (u.failedAttempts ?? 0) > 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">{u.failedAttempts} failed</span>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground">{u.roles?.length ? u.roles.join(', ') : '—'}</td>
                  <td>
                    <div className="flex gap-1">
                      <Badge tone="neutral">Local</Badge>
                      {google && <Badge tone="info">Google</Badge>}
                    </div>
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(u._id); }}>Manage</Button>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={5}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {users.length ? 'No users match your search.' : `No users in ${tenantName} yet.`}
                    {!users.length && (
                      <div className="mt-3"><Button size="sm" onClick={() => setCreating(true)}>Create the first user</Button></div>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>

      {selected && (
        <UserDetailDrawer user={selected} tenantId={activeTenantId} tenantName={tenantName} onClose={() => setSelectedId(null)} />
      )}

      {creating && (
        <CreateUserModal tenantId={activeTenantId} tenantName={tenantName} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function CreateUserModal({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Create user" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Create user</h2>
          <p className="text-sm text-muted-foreground">A local-credential account in {tenantName}.</p>
        </div>
        <ActionForm action={createUser} submitLabel="Create user" onResult={onClose}>
          <Hidden name="tenantId" value={tenantId} />
          <Field name="email" label="Email" type="email" required />
          <Field name="password" label="Temp password" type="password" required />
          <Field name="roles" label="Roles (comma)" placeholder="optional" />
        </ActionForm>
      </div>
    </div>
  );
}
