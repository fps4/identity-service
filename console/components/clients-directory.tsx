'use client';

// The credentials (OAuth clients) directory (ADR-0020): all credentials across the deployment, each shown
// with the application it belongs to. Client-side search + a table with type badges, opening a per-
// credential detail drawer. Register requires choosing an application (a credential can't exist without
// one). Reuses the client server actions (register / rotate / delete).

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Table, THead, TBody } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Field, Hidden, SelectField } from '@/components/field';
import { ClientDetailDrawer } from '@/components/client-detail-drawer';
import { createClient } from '@/app/actions';
import type { Application, Client } from '@/lib/api';

const inputCls =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function ClientsDirectory({ clients, applications = [], loadError }: {
  clients: Client[];
  applications?: Application[];
  loadError?: string;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const appName = (id: string) => applications.find((a) => a._id === id)?.name;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q) || c._id.toLowerCase().includes(q));
  }, [clients, query]);

  const selected = selectedId ? clients.find((c) => c._id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Search credentials"
          placeholder="Search name or client id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <span className="text-sm text-muted-foreground">{filtered.length} of {clients.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>Register credential</Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-destructive">Couldn’t load credentials: {loadError}</p>}

      <div className="rounded-lg border">
        <Table>
          <THead>
            <tr><th>Credential</th><th>Application</th><th>Type</th><th>Grants</th><th className="w-0" /></tr>
          </THead>
          <TBody>
            {filtered.map((c) => {
              const confidential = c.isConfidential !== false;
              return (
                <tr key={c._id} onClick={() => setSelectedId(c._id)} className="cursor-pointer">
                  <td>
                    <div className="font-medium">{c.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c._id}</div>
                  </td>
                  <td>
                    <div className="text-sm">{appName(c.applicationId) ?? <span className="text-muted-foreground">—</span>}</div>
                    <div className="font-mono text-xs text-muted-foreground">{c.applicationId}</div>
                  </td>
                  <td>{confidential ? <Badge tone="neutral">Confidential</Badge> : <Badge tone="info">Public / PKCE</Badge>}</td>
                  <td className="text-muted-foreground">{c.grantTypes?.join(', ') || '—'}</td>
                  <td><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(c._id); }}>Manage</Button></td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={5}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {clients.length ? 'No credentials match your search.' : 'No credentials yet.'}
                    {!clients.length && <div className="mt-3"><Button size="sm" onClick={() => setCreating(true)}>Register the first credential</Button></div>}
                  </div>
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>

      {selected && (
        <ClientDetailDrawer client={selected} applicationName={appName(selected.applicationId)} onClose={() => setSelectedId(null)} />
      )}

      {creating && (
        <CreateClientModal applications={applications} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function CreateClientModal({ applications, onClose }: { applications: Application[]; onClose: () => void }) {
  const [applicationId, setApplicationId] = useState(applications[0]?._id ?? '');

  return (
    <div role="dialog" aria-modal="true" aria-label="Register credential" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Register credential</h2>
          <p className="text-sm text-muted-foreground">A new OAuth client under an application. A confidential client’s secret is shown once.</p>
        </div>
        {!applications.length ? (
          <p className="text-sm text-destructive">Create an application first — a credential must belong to one.</p>
        ) : (
        /* onResult intentionally omitted: createClient may return a show-once secret, which ActionForm
            keeps on screen until dismissed — closing the dialog then would hide it. */
        <ActionForm action={createClient} submitLabel="Register">
          <Hidden name="applicationId" value={applicationId} />
          <div className="flex flex-col gap-1">
            <label htmlFor="credential-app" className="text-xs font-medium text-muted-foreground">Application</label>
            <select
              id="credential-app"
              aria-label="Application"
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              className="flex h-9 w-56 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {applications.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
            </select>
          </div>
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
        )}
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
