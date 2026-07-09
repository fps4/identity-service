'use client';

// The per-user assignments view (ADR-0020), shown inside the user detail drawer. A user reaches an
// application only through an assignment (entitlement + app-scoped roles). Lists the applications this
// user is in with their roles + status, and offers assign-to-app (pick an application, choose roles from
// THAT application's catalogue), change-roles, suspend/resume, and revoke — all through the audited
// assignment server actions. Data is hydrated via the fetch* actions and re-pulled on a reload counter.

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Hidden, RoleCheckboxes } from '@/components/field';
import { fetchUserAssignments, assignUser, updateAssignment, revokeAssignment } from '@/app/actions';
import type { AppRole, Application, Assignment } from '@/lib/api';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function UserAssignmentsSection({ email, applications }: { email: string; applications: Application[] }) {
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

  const catalogueFor = (id: string) => applications.find((a) => a._id === id)?.roles ?? [];
  const assignedIds = new Set(assignments.map((a) => a.applicationId));
  const assignable = applications.filter((a) => !assignedIds.has(a._id));

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
                <AssignmentRow key={a.applicationId} email={email} assignment={a} catalogue={catalogueFor(a.applicationId)} onChanged={refresh} />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Not assigned to any application.</p>
          )}
          <div className="mt-4 border-t pt-3">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">Assign to an application</h4>
            {assignable.length ? (
              <AssignToApp email={email} applications={assignable} onAssigned={refresh} />
            ) : (
              <p className="text-xs text-muted-foreground">{applications.length ? 'Already in every application.' : 'No applications to assign.'}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function AssignmentRow({ email, assignment, catalogue, onChanged }: {
  email: string; assignment: Assignment; catalogue: AppRole[]; onChanged: () => void;
}) {
  const suspended = assignment.status === 'suspended';
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{assignment.applicationName || assignment.applicationId}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{assignment.applicationId}</div>
        </div>
        <Badge tone={suspended ? 'warning' : 'success'} dot>{cap(assignment.status)}</Badge>
        <div className="ml-auto flex items-center gap-2">
          <ActionForm action={updateAssignment} submitLabel={suspended ? 'Resume' : 'Suspend'} variant="outline" inline onResult={onChanged}>
            <Hidden name="email" value={email} />
            <Hidden name="applicationId" value={assignment.applicationId} />
            <Hidden name="status" value={suspended ? 'active' : 'suspended'} />
          </ActionForm>
          <ActionForm action={revokeAssignment} submitLabel="Revoke" variant="destructive" confirm={`Revoke access to ${assignment.applicationName || assignment.applicationId}?`} inline onResult={onChanged}>
            <Hidden name="email" value={email} />
            <Hidden name="applicationId" value={assignment.applicationId} />
          </ActionForm>
        </div>
      </div>
      <div className="mt-2">
        <ActionForm action={updateAssignment} submitLabel="Save roles" variant="outline" onResult={onChanged}>
          <Hidden name="email" value={email} />
          <Hidden name="applicationId" value={assignment.applicationId} />
          <Hidden name="_setRoles" value="1" />
          <RoleCheckboxes catalogue={catalogue} selected={assignment.roles} label="" />
        </ActionForm>
      </div>
    </li>
  );
}

function AssignToApp({ email, applications, onAssigned }: {
  email: string; applications: Application[]; onAssigned: () => void;
}) {
  const [applicationId, setApplicationId] = useState(applications[0]?._id ?? '');
  const catalogue = applications.find((a) => a._id === applicationId)?.roles ?? [];

  return (
    <ActionForm action={assignUser} submitLabel="Assign" variant="outline" onResult={onAssigned}>
      <Hidden name="email" value={email} />
      <Hidden name="applicationId" value={applicationId} />
      <div className="flex flex-col gap-1">
        <label htmlFor="assign-app" className="text-xs font-medium text-muted-foreground">Application</label>
        <select
          id="assign-app"
          aria-label="Application"
          value={applicationId}
          onChange={(e) => setApplicationId(e.target.value)}
          className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {applications.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
        </select>
      </div>
      <RoleCheckboxes catalogue={catalogue} />
    </ActionForm>
  );
}
