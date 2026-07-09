import { api } from '@/lib/api';
import { ApplicationsDirectory } from '@/components/applications-directory';

export const dynamic = 'force-dynamic';

// The applications directory (ADR-0020). Thin server component: load the applications (the top-level
// products) and hand them to the client directory for search / detail-drawer management (role catalogue,
// members, credentials). Degrades gracefully on a failed read.
export default async function ApplicationsPage() {
  let applications: Awaited<ReturnType<typeof api.listApplications>> = [];
  let loadError: string | undefined;
  try { applications = await api.listApplications(); } catch (e) { loadError = (e as Error).message; }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Applications</h1>
        <p className="text-sm text-muted-foreground">
          The products on this deployment. Each owns its role catalogue, its members, and its OAuth
          credentials.
        </p>
      </div>

      <ApplicationsDirectory applications={applications} loadError={loadError} />
    </div>
  );
}
