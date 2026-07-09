import { api } from '@/lib/api';
import { UsersDirectory } from '@/components/users-directory';

export const dynamic = 'force-dynamic';

// The users directory (RQ-0014, ADR-0014). A thin server component: load the users and hand them to the
// client directory for search / filter / detail-drawer management. Degrades gracefully — a failed users
// read still leaves the create action usable.
export default async function UsersPage() {
  let users: Awaited<ReturnType<typeof api.listUsers>> = [];
  let clients: Awaited<ReturnType<typeof api.listClients>> = [];
  let loadError: string | undefined;
  try { users = await api.listUsers(); } catch (e) { loadError = (e as Error).message; }
  // Applications feed the assign-to-app picker in the user drawer (ADR-0019). A failed read just leaves
  // the picker empty; the rest of the page still works.
  try { clients = await api.listClients(); } catch { /* non-fatal */ }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Find a user, then manage them from their own record.
        </p>
      </div>

      <UsersDirectory users={users} clients={clients} loadError={loadError} />
    </div>
  );
}
