'use client';

// The applications (OAuth clients) directory (RQ-0017, ADR-0014): tenant picker + client-side search +
// a table with type badges, opening a per-application detail drawer. Replaces the form-first clients
// page that required a hand-typed ?tenantId= to list anything. Reuses the existing per-tenant
// listClients read and the client server actions (register / rotate / delete).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Table, THead, TBody } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Field, Hidden, SelectField } from '@/components/field';
import { ClientDetailDrawer } from '@/components/client-detail-drawer';
import { createClient } from '@/app/actions';
import type { Client } from '@/lib/api';

type TenantOption = { _id: string; name: string };

const inputCls =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function ClientsDirectory({ tenants, activeTenantId, clients, loadError }: {
  tenants: TenantOption[];
  activeTenantId: string;
  clients: Client[];
  loadError?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const activeTenant = tenants.find((t) => t._id === activeTenantId);
  const tenantName = activeTenant?.name ?? activeTenantId;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) => c.name.toLowerCase().includes(q) || c._id.toLowerCase().includes(q));
  }, [clients, query]);

  const selected = selectedId ? clients.find((c) => c._id === selectedId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Tenant"
          value={activeTenantId}
          onChange={(e) => router.push(`/clients?tenantId=${encodeURIComponent(e.target.value)}`)}
          className={inputCls}
        >
          {tenants.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
        </select>
        <input
          aria-label="Search applications"
          placeholder="Search name or client id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${inputCls} w-64`}
        />
        <span className="text-sm text-muted-foreground">{filtered.length} of {clients.length}</span>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating(true)}>Register application</Button>
        </div>
      </div>

      {loadError && <p className="text-sm text-destructive">Couldn’t load applications: {loadError}</p>}

      <div className="rounded-lg border">
        <Table>
          <THead>
            <tr><th>Application</th><th>Type</th><th>Grants</th><th>Scopes</th><th className="w-0" /></tr>
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
                  <td>{confidential ? <Badge tone="neutral">Confidential</Badge> : <Badge tone="info">Public / PKCE</Badge>}</td>
                  <td className="text-muted-foreground">{c.grantTypes?.join(', ') || '—'}</td>
                  <td className="text-muted-foreground">{c.scopes?.join(', ') || '—'}</td>
                  <td><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(c._id); }}>Manage</Button></td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={5}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    {clients.length ? 'No applications match your search.' : `No applications in ${tenantName} yet.`}
                    {!clients.length && <div className="mt-3"><Button size="sm" onClick={() => setCreating(true)}>Register the first application</Button></div>}
                  </div>
                </td>
              </tr>
            )}
          </TBody>
        </Table>
      </div>

      {selected && (
        <ClientDetailDrawer client={selected} tenantName={tenantName} onClose={() => setSelectedId(null)} />
      )}

      {creating && (
        <CreateClientModal tenantId={activeTenantId} tenantName={tenantName} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}

function CreateClientModal({ tenantId, tenantName, onClose }: { tenantId: string; tenantName: string; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Register application" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-lg border bg-background p-6 shadow-lg">
        <div>
          <h2 className="text-lg font-semibold">Register application</h2>
          <p className="text-sm text-muted-foreground">A new OAuth client in {tenantName}. A confidential client’s secret is shown once.</p>
        </div>
        {/* onResult intentionally omitted: createClient may return a show-once secret, which ActionForm
            keeps on screen until dismissed — closing the dialog then would hide it. */}
        <ActionForm action={createClient} submitLabel="Register">
          <Hidden name="tenantId" value={tenantId} />
          <Field name="name" label="Name" placeholder="my-service" required />
          <Field name="grantTypes" label="Grant types (comma)" placeholder="client_credentials" required />
          <Field name="scopes" label="Scopes (comma)" placeholder="optional" />
          <Field name="audience" label="Audience" placeholder="optional" />
          <Field name="redirectUris" label="Redirect URIs (comma)" placeholder="optional" />
          <SelectField name="isConfidential" label="Type" options={[
            { value: 'true', label: 'Confidential (has a secret)' },
            { value: 'false', label: 'Public / PKCE (no secret)' },
          ]} defaultValue="true" />
        </ActionForm>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
