import { api } from '@/lib/api';
import { UsersDirectory } from '@/components/users-directory';

export const dynamic = 'force-dynamic';

// The users directory (RQ-0014, ADR-0014). A thin server component: resolve the selected tenant
// (default = first, carried in ?tenantId=), load that tenant's users via the existing per-tenant read,
// and hand them to the client directory for search / filter / detail-drawer management. Degrades
// gracefully — a failed users read still leaves the tenant picker and create action usable.
export default async function UsersPage({ searchParams }: { searchParams: Promise<{ tenantId?: string }> }) {
  const { tenantId } = await searchParams;
  const tenants = await api.listTenants().catch(() => []);
  const active = tenantId && tenants.some((t) => t._id === tenantId) ? tenantId : tenants[0]?._id;

  let users: Awaited<ReturnType<typeof api.listUsers>> = [];
  let loadError: string | undefined;
  if (active) {
    try { users = await api.listUsers(active); } catch (e) { loadError = (e as Error).message; }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Find a user, then manage them from their own record. Pick a tenant to see its directory.
        </p>
      </div>

      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tenants yet — onboard one first.</p>
      ) : (
        <UsersDirectory
          tenants={tenants.map((t) => ({ _id: t._id, name: t.name }))}
          activeTenantId={active as string}
          users={users}
          loadError={loadError}
        />
      )}
    </div>
  );
}
