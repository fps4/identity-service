import { api } from '@/lib/api';
import { ClientsDirectory } from '@/components/clients-directory';

export const dynamic = 'force-dynamic';

// The applications directory (RQ-0017, ADR-0014). Thin server component: load the OAuth clients and hand
// them to the client directory for search / detail-drawer management. Degrades gracefully on a failed read.
export default async function ClientsPage() {
  let clients: Awaited<ReturnType<typeof api.listClients>> = [];
  let loadError: string | undefined;
  try { clients = await api.listClients(); } catch (e) { loadError = (e as Error).message; }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Applications</h1>
        <p className="text-sm text-muted-foreground">
          OAuth clients registered on this deployment. Rotate a secret from the application’s own record.
        </p>
      </div>

      <ClientsDirectory clients={clients} loadError={loadError} />
    </div>
  );
}
