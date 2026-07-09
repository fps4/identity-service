'use client';

// The applications directory (ADR-0020): the top-level product list. Client-side search + a table with a
// role-count and credential-count, opening a per-application detail drawer (role catalogue, members,
// credentials). Create mints an application via the createApplication server action.

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Table, THead, TBody } from '@/components/ui/table';
import { ActionForm } from '@/components/action-form';
import { Field } from '@/components/field';
import { ApplicationDetailDrawer } from '@/components/application-detail-drawer';
import { createApplication } from '@/app/actions';
import type { Application } from '@/lib/api';

const inputCls =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function ApplicationsDirectory({ applications, loadError }: {
  applications: Application[];
  loadError?: string;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return applications;
    return applications.filter((a) => a.name.toLowerCase().includes(q) || a._id.toLowerCase().includes(q));
  }, [applications, query]);

  const selected = selectedId ? applications.find((a) => a._id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search applications"
          placeholder="Search name or application id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <span className="text-sm text-muted-foreground">{filtered.length} of {applications.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>Create application</Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-destructive">Couldn’t load applications: {loadError}</p>}

      <div className="rounded-lg border">
        <Table>
          <THead>
            <tr><th>Application</th><th>Audience</th><th>Roles</th><th className="w-0" /></tr>
          </THead>
          <TBody>
            {filtered.map((a) => (
              <tr key={a._id} onClick={() => setSelectedId(a._id)} className="cursor-pointer">
                <td>
                  <div className="font-medium">{a.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{a._id}</div>
                </td>
                <td className="font-mono text-xs text-muted-foreground">{a.audience || '—'}</td>
                <td className="text-muted-foreground">{a.roles?.length ? a.roles.map((r) => r.key).join(', ') : '—'}</td>
                <td><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(a._id); }}>Manage</Button></td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={4}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {applications.length ? 'No applications match your search.' : 'No applications yet.'}
                    {!applications.length && <div className="mt-3"><Button size="sm" onClick={() => setCreating(true)}>Create the first application</Button></div>}
                  </div>
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>

      {selected && (
        <ApplicationDetailDrawer application={selected} onClose={() => setSelectedId(null)} />
      )}

      {creating && (
        <CreateApplicationModal onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function CreateApplicationModal({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Create application" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Create application</h2>
          <p className="text-sm text-muted-foreground">A product: its name, default audience, and role catalogue. Add credentials afterwards.</p>
        </div>
        <ActionForm action={createApplication} submitLabel="Create" onResult={onClose}>
          <Field name="name" label="Name" placeholder="acme-web" required />
          <Field name="audience" label="Default audience" placeholder="optional" />
          <Field name="roles" label="Role catalogue keys (comma)" placeholder="e.g. admin, member" />
        </ActionForm>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
