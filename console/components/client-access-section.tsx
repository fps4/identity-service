'use client';

// Per-application access management (ADR-0019): the role catalogue editor + the members list, shown
// inside the application detail drawer. Each application owns a role catalogue; a user only reaches the
// application through an assignment (entitlement + app-scoped roles). Data is hydrated from the server
// via the fetch* actions; every mutation routes through the audited assignment/catalogue server actions
// and bumps a reload counter so the drawer restreams fresh state.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/action-form';
import { Field, Hidden, RoleCheckboxes } from '@/components/field';
import {
  fetchClientRoles, fetchClientMembers,
  setClientRoles, assignUser, updateAssignment, revokeAssignment,
} from '@/app/actions';
import type { AppRole, Member } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ClientAccessSection({ clientId }: { clientId: string }) {
  const [catalogue, setCatalogue] = useState<AppRole[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([fetchClientRoles(clientId), fetchClientMembers(clientId)])
      .then(([roles, mem]) => { if (live) { setCatalogue(roles); setMembers(mem); setError(undefined); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [clientId, reload]);

  return (
    <>
      <section className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role catalogue</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Roles this application defines. Assignments and invites draw from this catalogue.
        </p>
        {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : <RoleCatalogueEditor clientId={clientId} catalogue={catalogue} onSaved={refresh} />}
      </section>

      <section className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</h3>
        {error && <p className="text-xs text-destructive">Couldn’t load members: {error}</p>}
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {members.length ? (
              <ul className="space-y-3">
                {members.map((m) => (
                  <MemberRow key={m.userId} clientId={clientId} member={m} catalogue={catalogue} onChanged={refresh} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No members yet.</p>
            )}
            <div className="mt-4 border-t pt-3">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">Assign a user</h4>
              <ActionForm action={assignUser} submitLabel="Assign" variant="outline" onResult={refresh}>
                <Hidden name="clientId" value={clientId} />
                <Field name="email" label="User email" type="email" placeholder="user@acme.com" required />
                <RoleCheckboxes catalogue={catalogue} />
              </ActionForm>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function RoleCatalogueEditor({ clientId, catalogue, onSaved }: {
  clientId: string; catalogue: AppRole[]; onSaved: () => void;
}) {
  const [rows, setRows] = useState<AppRole[]>(catalogue);
  const update = (i: number, patch: Partial<AppRole>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => setRows((rs) => [...rs, { key: '', name: '', description: '' }]);
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const clean = rows.map((r) => ({ key: r.key.trim(), name: r.name?.trim() || undefined, description: r.description?.trim() || undefined })).filter((r) => r.key);

  return (
    <ActionForm action={setClientRoles} submitLabel="Save catalogue" variant="outline" onResult={onSaved}>
      <Hidden name="clientId" value={clientId} />
      <Hidden name="roles" value={JSON.stringify(clean)} />
      <div className="w-full space-y-2">
        {rows.length ? rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input aria-label={`Role key ${i + 1}`} placeholder="key" value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
              className="h-8 w-28 rounded-md border border-input bg-transparent px-2 text-sm" />
            <input aria-label={`Role name ${i + 1}`} placeholder="name" value={r.name ?? ''}
              onChange={(e) => update(i, { name: e.target.value })}
              className="h-8 w-32 rounded-md border border-input bg-transparent px-2 text-sm" />
            <input aria-label={`Role description ${i + 1}`} placeholder="description" value={r.description ?? ''}
              onChange={(e) => update(i, { description: e.target.value })}
              className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm" />
            <button type="button" onClick={() => remove(i)} aria-label={`Remove role ${i + 1}`}
              className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent">✕</button>
          </div>
        )) : <p className="text-xs text-muted-foreground">No roles defined.</p>}
        <Button type="button" size="sm" variant="ghost" onClick={add}>+ Add role</Button>
      </div>
    </ActionForm>
  );
}

function MemberRow({ clientId, member, catalogue, onChanged }: {
  clientId: string; member: Member; catalogue: AppRole[]; onChanged: () => void;
}) {
  const suspended = member.status === 'suspended';
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">{member.email || member.userId}</span>
        <Badge tone={suspended ? 'warning' : 'success'} dot>{cap(member.status)}</Badge>
        {member.userStatus && member.userStatus !== 'active' ? <Badge tone="neutral">{member.userStatus}</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <ActionForm action={updateAssignment} submitLabel={suspended ? 'Resume' : 'Suspend'} variant="outline" inline onResult={onChanged}>
            <Hidden name="email" value={member.email ?? ''} />
            <Hidden name="clientId" value={clientId} />
            <Hidden name="status" value={suspended ? 'active' : 'suspended'} />
          </ActionForm>
          <ActionForm action={revokeAssignment} submitLabel="Revoke" variant="destructive" confirm={`Revoke ${member.email || member.userId}'s access to this application?`} inline onResult={onChanged}>
            <Hidden name="email" value={member.email ?? ''} />
            <Hidden name="clientId" value={clientId} />
          </ActionForm>
        </div>
      </div>
      <div className="mt-2">
        <ActionForm action={updateAssignment} submitLabel="Save roles" variant="outline" onResult={onChanged}>
          <Hidden name="email" value={member.email ?? ''} />
          <Hidden name="clientId" value={clientId} />
          <Hidden name="_setRoles" value="1" />
          <RoleCheckboxes catalogue={catalogue} selected={member.roles} label="" />
        </ActionForm>
      </div>
    </li>
  );
}
