'use client';

// Per-application (OAuth client) detail drawer (RQ-0017, ADR-0014). Opened from the clients directory;
// routes rotate-secret and delete through the existing audited server actions. Rotate is offered only
// for confidential clients (public/PKCE clients have no secret). The new secret comes back once and is
// shown via ActionForm's show-once dialog.

import { Drawer } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { ActionForm } from '@/components/action-form';
import { Hidden } from '@/components/field';
import { ClientAccessSection } from '@/components/client-access-section';
import { rotateClientSecret, deleteClient } from '@/app/actions';
import type { Client } from '@/lib/api';

export function ClientDetailDrawer({ client, onClose }: {
  client: Client;
  onClose: () => void;
}) {
  const confidential = client.isConfidential !== false;
  const redirectUris = client.redirectUris ?? [];

  return (
    <Drawer
      ariaLabel={`Application ${client.name}`}
      title={client.name}
      subtitle={client._id}
      badges={confidential
        ? <Badge tone="neutral">Confidential</Badge>
        : <Badge tone="info">Public / PKCE</Badge>}
      onClose={onClose}
      footer={
        <>
          {confidential && (
            <ActionForm action={rotateClientSecret} submitLabel="Rotate secret" variant="outline" inline>
              <Hidden name="clientId" value={client._id} />
            </ActionForm>
          )}
          <div className="ml-auto">
            <ActionForm action={deleteClient} submitLabel="Delete" variant="destructive" confirm={`Delete application ${client.name}? Tokens it issued stop validating.`} inline>
              <Hidden name="clientId" value={client._id} />
            </ActionForm>
          </div>
        </>
      }
    >
      <div className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Configuration</h3>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">Client id</dt>
          <dd className="font-mono text-xs">{client._id}</dd>
          <dt className="text-muted-foreground">Grant types</dt>
          <dd>{client.grantTypes?.length ? client.grantTypes.map((g) => <span key={g} className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-xs">{g}</span>) : '—'}</dd>
          <dt className="text-muted-foreground">Scopes</dt>
          <dd>{client.scopes?.length ? client.scopes.map((sc) => <span key={sc} className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-xs">{sc}</span>) : '—'}</dd>
          <dt className="text-muted-foreground">Audience</dt>
          <dd className="font-mono text-xs">{client.audience || '—'}</dd>
          {redirectUris.length > 0 && (
            <>
              <dt className="text-muted-foreground">Redirect URIs</dt>
              <dd className="space-y-1">{redirectUris.map((u) => <div key={u} className="break-all font-mono text-xs">{u}</div>)}</dd>
            </>
          )}
        </dl>
      </div>

      <ClientAccessSection clientId={client._id} />

      <div className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Secret</h3>
        {confidential ? (
          <p className="text-xs text-muted-foreground">Only a hash is stored. Rotating issues a new secret shown exactly once and invalidates the old one immediately.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Public client — no secret. Login is proven with PKCE (S256).</p>
        )}
      </div>
    </Drawer>
  );
}
