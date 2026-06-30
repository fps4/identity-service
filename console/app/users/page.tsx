import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ActionForm } from '@/components/action-form';
import { Field, SelectField } from '@/components/field';
import { createUser, resetPassword, setUserStatus, unlockUser } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const tenants = await api.listTenants().catch(() => []);
  const tenantOptions = tenants.map((t) => ({ value: t._id, label: `${t.name} (${t._id})` }));

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Users</h1>
      <p className="text-sm text-muted-foreground">
        Tip: open a tenant to see and manage its full user list inline. These forms work by email across any tenant.
      </p>

      <Card>
        <CardHeader><CardTitle>Create a local-credential user</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={createUser} submitLabel="Create user">
            <SelectField name="tenantId" label="Tenant" options={tenantOptions} required />
            <Field name="email" label="Email" type="email" required />
            <Field name="password" label="Password" type="password" required />
            <Field name="roles" label="Roles (comma)" placeholder="optional" />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Reset password</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={resetPassword} submitLabel="Reset password">
            <SelectField name="tenantId" label="Tenant" options={tenantOptions} required />
            <Field name="email" label="Email" type="email" required />
            <Field name="password" label="New password" type="password" required />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Set status (active / disabled)</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={setUserStatus} submitLabel="Set status">
            <SelectField name="tenantId" label="Tenant" options={tenantOptions} required />
            <Field name="email" label="Email" type="email" required />
            <Field name="status" label="Status (active/disabled)" placeholder="disabled" required />
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Unlock (clear brute-force lockout)</CardTitle></CardHeader>
        <CardContent>
          <ActionForm action={unlockUser} submitLabel="Unlock user">
            <SelectField name="tenantId" label="Tenant" options={tenantOptions} required />
            <Field name="email" label="Email" type="email" required />
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
