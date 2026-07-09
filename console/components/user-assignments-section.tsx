'use client';

// The per-user assignments view (ADR-0019), shown inside the user detail drawer. A user reaches an
// application only through an assignment (entitlement + app-scoped roles). Lists the applications this
// user is in with their roles + status, and offers assign-to-app (pick an application, choose roles from
// THAT application's catalogue), change-roles, suspend/resume, and revoke — all through the audited
// assignment server actions. Data is hydrated via the fetch* actions and re-pulled on a reload counter.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Hidden, RoleCheckboxes } from '@/components/field';
import {
  fetchUserAssignments, fetchClientRoles,
  assignUser, updateAssignment, revokeAssignment,
} from '@/app/actions';
import type { AppRole, Assignment, Client } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function UserAssignmentsSection({ email, clients }: { email: string; clients: Client[] }) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchUserAssignments(email)
      .then((a) => { if (live) { setAssignments(a); setError(undefined); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [email, reload]);

  const assignedIds = new Set(assignments.map((a) => a.clientId));
  const assignable = clients.filter((c) => !assignedIds.has(c._id));

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Application access</h3>
      {error && <p className="text-xs text-destructive">Couldn’t load assignments: {error}</p>}
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          {assignments.length ? (
            <ul className="space-y-3">
              {assignments.map((a) => (
                <AssignmentRow key={a.clientId} email={email} assignment={a} onChanged={refresh} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Not assigned to any application.</p>
          )}
          <div className="mt-4 border-t pt-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">Assign to an application</h4>
            {assignable.length ? (
              <AssignToApp email={email} clients={assignable} onAssigned={refresh} />
            ) : (
              <p className="text-xs text-muted-foreground">{clients.length ? 'Already in every application.' : 'No applications to assign.'}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function AssignmentRow({ email, assignment, onChanged }: {
  email: string; assignment: Assignment; onChanged: () => void;
}) {
  const [catalogue, setCatalogue] = useState<AppRole[]>([]);
  useEffect(() => {
    let live = true;
    fetchClientRoles(assignment.clientId).then((r) => { if (live) setCatalogue(r); }).catch(() => {});
    return () => { live = false; };
  }, [assignment.clientId]);

  const suspended = assignment.status === 'suspended';
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{assignment.clientName || assignment.clientId}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{assignment.clientId}</div>
        </div>
        <Badge tone={suspended ? 'warning' : 'success'} dot>{cap(assignment.status)}</Badge>
        <div className="ml-auto flex items-center gap-2">
          <ActionForm action={updateAssignment} submitLabel={suspended ? 'Resume' : 'Suspend'} variant="outline" inline onResult={onChanged}>
            <Hidden name="email" value={email} />
            <Hidden name="clientId" value={assignment.clientId} />
            <Hidden name="status" value={suspended ? 'active' : 'suspended'} />
          </ActionForm>
          <ActionForm action={revokeAssignment} submitLabel="Revoke" variant="destructive" confirm={`Revoke access to ${assignment.clientName || assignment.clientId}?`} inline onResult={onChanged}>
            <Hidden name="email" value={email} />
            <Hidden name="clientId" value={assignment.clientId} />
          </ActionForm>
        </div>
      </div>
      <div className="mt-2">
        <ActionForm action={updateAssignment} submitLabel="Save roles" variant="outline" onResult={onChanged}>
          <Hidden name="email" value={email} />
          <Hidden name="clientId" value={assignment.clientId} />
          <Hidden name="_setRoles" value="1" />
          <RoleCheckboxes catalogue={catalogue} selected={assignment.roles} label="" />
        </ActionForm>
      </div>
    </li>
  );
}

function AssignToApp({ email, clients, onAssigned }: {
  email: string; clients: Client[]; onAssigned: () => void;
}) {
  const [clientId, setClientId] = useState(clients[0]?._id ?? '');
  const [catalogue, setCatalogue] = useState<AppRole[]>([]);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    fetchClientRoles(clientId).then((r) => { if (live) setCatalogue(r); }).catch(() => { if (live) setCatalogue([]); });
    return () => { live = false; };
  }, [clientId]);

  return (
    <ActionForm action={assignUser} submitLabel="Assign" variant="outline" onResult={onAssigned}>
      <Hidden name="email" value={email} />
      <Hidden name="clientId" value={clientId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="assign-app" className="text-xs font-medium text-muted-foreground">Application</label>
        <select
          id="assign-app"
          aria-label="Application"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {clients.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
        </select>
      </div>
      <RoleCheckboxes catalogue={catalogue} />
    </ActionForm>
  );
}
