'use client';

// Per-application access management (ADR-0020): the role-catalogue editor, the members list, and the
// application's credentials, shown inside the application detail drawer. The application owns its role
// catalogue; a user only reaches it through an assignment (entitlement + app-scoped roles); OAuth clients
// are credentials under it. Data is hydrated from the server via the fetch* actions; every mutation routes
// through the audited server actions and bumps a reload counter so the drawer restreams fresh state.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ActionForm } from '@/components/action-form';
import { Field, Hidden, RoleCheckboxes, SelectField } from '@/components/field';
import {
  fetchApplicationRoles, fetchApplicationMembers, fetchApplicationCredentials,
  setApplicationRoles, assignUser, updateAssignment, revokeAssignment,
  createClient, rotateClientSecret, deleteClient,
} from '@/app/actions';
import type { AppRole, Client, Member } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ApplicationAccessSection({ applicationId }: { applicationId: string }) {
  const [catalogue, setCatalogue] = useState<AppRole[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [credentials, setCredentials] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      fetchApplicationRoles(applicationId),
      fetchApplicationMembers(applicationId),
      fetchApplicationCredentials(applicationId),
    ])
      .then(([roles, mem, creds]) => { if (live) { setCatalogue(roles); setMembers(mem); setCredentials(creds); setError(undefined); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [applicationId, reload]);

  return (
    <>
      <section className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Role catalogue</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Roles this application defines. Assignments and invites draw from this catalogue.
        </p>
        {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : <RoleCatalogueEditor applicationId={applicationId} catalogue={catalogue} onSaved={refresh} />}
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
                  <MemberRow key={m.userId} applicationId={applicationId} member={m} catalogue={catalogue} onChanged={refresh} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No members yet.</p>
            )}
            <div className="mt-4 border-t pt-3">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">Assign a user</h4>
              <ActionForm action={assignUser} submitLabel="Assign" variant="outline" onResult={refresh}>
                <Hidden name="applicationId" value={applicationId} />
                <Field name="email" label="User email" type="email" placeholder="user@acme.com" required />
                <RoleCheckboxes catalogue={catalogue} />
              </ActionForm>
            </div>
          </>
        )}
      </section>

      <section className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Credentials</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          OAuth clients under this application — e.g. a web-login credential, a machine/runtime credential.
        </p>
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <>
            {credentials.length ? (
              <ul className="space-y-3">
                {credentials.map((c) => (
                  <CredentialRow key={c._id} client={c} onChanged={refresh} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No credentials yet.</p>
            )}
            <div className="mt-4 border-t pt-3">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">Add a credential</h4>
              {/* onResult omitted: createClient returns a show-once secret that ActionForm keeps on screen. */}
              <ActionForm action={createClient} submitLabel="Add credential" variant="outline">
                <Hidden name="applicationId" value={applicationId} />
                <Field name="name" label="Name" placeholder="my-service" required />
                <Field name="grantTypes" label="Grant types (comma)" placeholder="client_credentials" required />
                <Field name="scopes" label="Scopes (comma)" placeholder="optional" />
                <Field name="audience" label="Audience override" placeholder="optional" />
                <Field name="redirectUris" label="Redirect URIs (comma)" placeholder="optional" />
                <SelectField name="isConfidential" label="Type" options={[
                  { value: 'true', label: 'Confidential (has a secret)' },
                  { value: 'false', label: 'Public / PKCE (no secret)' },
                ]} defaultValue="true" />
              </ActionForm>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function RoleCatalogueEditor({ applicationId, catalogue, onSaved }: {
  applicationId: string; catalogue: AppRole[]; onSaved: () => void;
}) {
  const [rows, setRows] = useState<AppRole[]>(catalogue);
  const update = (i: number, patch: Partial<AppRole>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const add = () => setRows((rs) => [...rs, { key: '', name: '', description: '' }]);
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));
  const clean = rows.map((r) => ({ key: r.key.trim(), name: r.name?.trim() || undefined, description: r.description?.trim() || undefined })).filter((r) => r.key);

  return (
    <ActionForm action={setApplicationRoles} submitLabel="Save catalogue" variant="outline" onResult={onSaved}>
      <Hidden name="applicationId" value={applicationId} />
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

function MemberRow({ applicationId, member, catalogue, onChanged }: {
  applicationId: string; member: Member; catalogue: AppRole[]; onChanged: () => void;
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
            <Hidden name="applicationId" value={applicationId} />
            <Hidden name="status" value={suspended ? 'active' : 'suspended'} />
          </ActionForm>
          <ActionForm action={revokeAssignment} submitLabel="Revoke" variant="destructive" confirm={`Revoke ${member.email || member.userId}'s access to this application?`} inline onResult={onChanged}>
            <Hidden name="email" value={member.email ?? ''} />
            <Hidden name="applicationId" value={applicationId} />
          </ActionForm>
        </div>
      </div>
      <div className="mt-2">
        <ActionForm action={updateAssignment} submitLabel="Save roles" variant="outline" onResult={onChanged}>
          <Hidden name="email" value={member.email ?? ''} />
          <Hidden name="applicationId" value={applicationId} />
          <Hidden name="_setRoles" value="1" />
          <RoleCheckboxes catalogue={catalogue} selected={member.roles} label="" />
        </ActionForm>
      </div>
    </li>
  );
}

function CredentialRow({ client, onChanged }: { client: Client; onChanged: () => void }) {
  const confidential = client.isConfidential !== false;
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{client.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{client._id}</div>
        </div>
        <Badge tone={confidential ? 'neutral' : 'info'}>{confidential ? 'Confidential' : 'Public / PKCE'}</Badge>
        <div className="ml-auto flex items-center gap-2">
          {confidential && (
            <ActionForm action={rotateClientSecret} submitLabel="Rotate secret" variant="outline" inline>
              <Hidden name="clientId" value={client._id} />
            </ActionForm>
          )}
          <ActionForm action={deleteClient} submitLabel="Delete" variant="destructive" confirm={`Delete credential ${client.name}? Tokens it issued stop validating.`} inline onResult={onChanged}>
            <Hidden name="clientId" value={client._id} />
          </ActionForm>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {client.grantTypes?.length ? client.grantTypes.join(', ') : '—'}
      </div>
    </li>
  );
}
