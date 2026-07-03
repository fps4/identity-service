import { api } from '@/lib/api';
import { ClientsDirectory } from '@/components/clients-directory';

export const dynamic = 'force-dynamic';

// The applications directory (RQ-0017, ADR-0014). Thin server component: resolve the selected tenant
// (default = first, carried in ?tenantId=), load that tenant's OAuth clients, and hand them to the
// client directory for search / detail-drawer management. Degrades gracefully on a failed read.
export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ tenantId?: string }> }) {
  const { tenantId } = await searchParams;
  const tenants = await api.listTenants().catch(() => []);
  const active = tenantId && tenants.some((t) => t._id === tenantId) ? tenantId : tenants[0]?._id;

  let clients: Awaited<ReturnType<typeof api.listClients>> = [];
  let loadError: string | undefined;
  if (active) {
    try { clients = await api.listClients(active); } catch (e) { loadError = (e as Error).message; }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Applications</h1>
        <p className="text-sm text-muted-foreground">
          OAuth clients registered per tenant. Rotate a secret from the application’s own record — pick a tenant to see its list.
        </p>
      </div>

      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tenants yet — onboard one first.</p>
      ) : (
        <ClientsDirectory
          tenants={tenants.map((t) => ({ _id: t._id, name: t.name }))}
          activeTenantId={active as string}
          clients={clients}
          loadError={loadError}
        />
      )}
    </div>
  );
}
