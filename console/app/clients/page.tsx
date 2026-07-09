import { api } from '@/lib/api';
import { ClientsDirectory } from '@/components/clients-directory';

export const dynamic = 'force-dynamic';

// The credentials directory (ADR-0020). Thin server component: load the OAuth clients (credentials) and
// the applications (so each credential shows its product, and register can pick one) and hand them to the
// client directory. Degrades gracefully on a failed read.
export default async function ClientsPage() {
  let clients: Awaited<ReturnType<typeof api.listClients>> = [];
  let applications: Awaited<ReturnType<typeof api.listApplications>> = [];
  let loadError: string | undefined;
  try { clients = await api.listClients(); } catch (e) { loadError = (e as Error).message; }
  // Applications feed the credential's application column + the register picker (ADR-0020). A failed read
  // just leaves names blank; the rest of the page still works.
  try { applications = await api.listApplications(); } catch { /* non-fatal */ }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Credentials</h1>
        <p className="text-sm text-muted-foreground">
          OAuth clients registered on this deployment, each under an application. Rotate a secret from the
          credential’s own record.
        </p>
      </div>

      <ClientsDirectory clients={clients} applications={applications} loadError={loadError} />
    </div>
  );
}
