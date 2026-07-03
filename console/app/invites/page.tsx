import { api } from '@/lib/api';
import { InvitesDirectory } from '@/components/invites-directory';

export const dynamic = 'force-dynamic';

// The registration invites directory (RQ-0017, ADR-0013/0014). Thin server component: resolve the
// selected tenant (default = first, carried in ?tenantId=), load that tenant's invites, and hand them
// to the client directory. Gives invites a first-class home; they were previously only reachable inside
// a tenant's detail page. Degrades gracefully on a failed read.
export default async function InvitesPage({ searchParams }: { searchParams: Promise<{ tenantId?: string }> }) {
  const { tenantId } = await searchParams;
  const tenants = await api.listTenants().catch(() => []);
  const active = tenantId && tenants.some((t) => t._id === tenantId) ? tenantId : tenants[0]?._id;

  let invites: Awaited<ReturnType<typeof api.listInvites>> = [];
  let loadError: string | undefined;
  if (active) {
    try { invites = await api.listInvites(active); } catch (e) { loadError = (e as Error).message; }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Invites</h1>
        <p className="text-sm text-muted-foreground">
          Operator-issued registration codes (RQ-0013). They gate self-registration on tenants whose
          policy is <span className="font-mono">invite</span>. Pick a tenant to see its invites.
        </p>
      </div>

      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tenants yet — onboard one first.</p>
      ) : (
        <InvitesDirectory
          tenants={tenants.map((t) => ({ _id: t._id, name: t.name }))}
          activeTenantId={active as string}
          invites={invites}
          loadError={loadError}
        />
      )}
    </div>
  );
}
