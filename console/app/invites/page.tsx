import { api } from '@/lib/api';
import { InvitesDirectory } from '@/components/invites-directory';

export const dynamic = 'force-dynamic';

// The registration invites directory (RQ-0017, ADR-0013/0014). Thin server component: load the invites
// and hand them to the client directory. Degrades gracefully on a failed read.
export default async function InvitesPage() {
  let invites: Awaited<ReturnType<typeof api.listInvites>> = [];
  let applications: Awaited<ReturnType<typeof api.listApplications>> = [];
  let loadError: string | undefined;
  try { invites = await api.listInvites(); } catch (e) { loadError = (e as Error).message; }
  // Applications feed the target-app picker + role catalogue in the create-invite form (ADR-0020).
  try { applications = await api.listApplications(); } catch { /* non-fatal */ }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Invites</h1>
        <p className="text-sm text-muted-foreground">
          Operator-issued registration codes (RQ-0013). They gate self-registration when the deployment’s
          policy is <span className="font-mono">invite</span>.
        </p>
      </div>

      <InvitesDirectory invites={invites} applications={applications} loadError={loadError} />
    </div>
  );
}
