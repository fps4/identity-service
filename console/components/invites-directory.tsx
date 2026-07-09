'use client';

// The registration invites directory (RQ-0017, ADR-0013, ADR-0014): a first-class home for invites.
// Client-side search + status filter + a table with status badges, opening a per-invite detail drawer.
// Create mints a show-once code via the existing createInvite action; revoke lives on the drawer.

import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Table, THead, TBody } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Field, SelectField, RoleCheckboxes, Hidden } from '@/components/field';
import { InviteDetailDrawer } from '@/components/invite-detail-drawer';
import { inviteStatusTone, type InviteStatus } from '@/lib/invites';
import { createInvite, fetchClientRoles } from '@/app/actions';
import type { Invite, Client, AppRole } from '@/lib/api';

type StatusFilter = 'all' | InviteStatus;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const inputCls =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function InvitesDirectory({ invites, clients = [], loadError }: {
  invites: Invite[];
  clients?: Client[];
  loadError?: string;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const clientName = (id: string) => clients.find((c) => c._id === id)?.name;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return invites.filter((inv) => {
      if (status !== 'all' && inv.status !== status) return false;
      if (q && !(inv.email ?? '').toLowerCase().includes(q) && !(inv.note ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [invites, query, status]);

  const selected = selectedId ? invites.find((inv) => inv._id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search invites"
          placeholder="Search email or note…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={inputCls}>
          <option value="all">Any status</option>
          <option value="pending">Pending</option>
          <option value="redeemed">Redeemed</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </select>
        <span className="text-sm text-muted-foreground">{filtered.length} of {invites.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>Create invite</Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-destructive">Couldn’t load invites: {loadError}</p>}

      <div className="rounded-lg border">
        <Table>
          <THead>
            <tr><th>Invite</th><th>Application</th><th>Status</th><th>Roles</th><th>Uses</th><th>Expires</th><th className="w-0" /></tr>
          </THead>
          <TBody>
            {filtered.map((inv) => (
              <tr key={inv._id} onClick={() => setSelectedId(inv._id)} className="cursor-pointer">
                <td>
                  <div className="font-medium">{inv.email || <span className="text-muted-foreground">Any email</span>}</div>
                  {inv.note ? <div className="text-xs text-muted-foreground">{inv.note}</div> : null}
                </td>
                <td>
                  <div className="text-sm">{clientName(inv.clientId) ?? <span className="text-muted-foreground">—</span>}</div>
                  <div className="font-mono text-xs text-muted-foreground">{inv.clientId}</div>
                </td>
                <td><Badge tone={inviteStatusTone(inv.status)} dot>{cap(inv.status)}</Badge></td>
                <td className="text-muted-foreground">{inv.roles?.length ? inv.roles.join(', ') : '—'}</td>
                <td className="text-muted-foreground">{inv.usedCount}/{inv.maxUses}</td>
                <td className="text-xs text-muted-foreground">{new Date(inv.expiresAt).toLocaleDateString()}</td>
                <td><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(inv._id); }}>Manage</Button></td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={7}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {invites.length ? 'No invites match your filters.' : 'No invites yet.'}
                    {!invites.length && <div className="mt-3"><Button size="sm" onClick={() => setCreating(true)}>Create the first invite</Button></div>}
                  </div>
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>

      {selected && (
        <InviteDetailDrawer invite={selected} clientName={clientName(selected.clientId)} onClose={() => setSelectedId(null)} />
      )}

      {creating && (
        <CreateInviteModal clients={clients} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function CreateInviteModal({ clients, onClose }: { clients: Client[]; onClose: () => void }) {
  // ADR-0019: an invite targets a specific application; its roles come from THAT application's catalogue.
  const [clientId, setClientId] = useState(clients[0]?._id ?? '');
  const [catalogue, setCatalogue] = useState<AppRole[]>([]);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    fetchClientRoles(clientId).then((r) => { if (live) setCatalogue(r); }).catch(() => { if (live) setCatalogue([]); });
    return () => { live = false; };
  }, [clientId]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Create invite" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Create invite</h2>
          <p className="text-sm text-muted-foreground">The code is shown once — send it to the invitee out-of-band.</p>
        </div>
        {!clients.length ? (
          <p className="text-sm text-destructive">Register an application first — an invite must target one.</p>
        ) : (
        /* onResult omitted: createInvite returns the show-once code, which ActionForm keeps on screen
           until dismissed — closing the dialog then would hide it before it is copied. */
        <ActionForm action={createInvite} submitLabel="Create invite">
          <Hidden name="clientId" value={clientId} />
          <div className="flex flex-col gap-1">
            <label htmlFor="invite-app" className="text-xs font-medium text-muted-foreground">Application</label>
            <select
              id="invite-app"
              aria-label="Application"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {clients.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </div>
          <Field name="email" label="Bind to email (optional)" type="email" placeholder="invitee@acme.com" />
          <RoleCheckboxes catalogue={catalogue} label="Roles" />
          <Field name="maxUses" label="Max uses" type="number" defaultValue="1" />
          <SelectField name="expiresInHours" label="Expires in" defaultValue="168" options={[
            { value: '24', label: '1 day' },
            { value: '72', label: '3 days' },
            { value: '168', label: '7 days' },
            { value: '720', label: '30 days' },
          ]} />
          <Field name="note" label="Note" placeholder="e.g. March cohort" />
        </ActionForm>
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
