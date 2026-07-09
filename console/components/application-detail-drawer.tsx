'use client';

// Application detail drawer (ADR-0020, ADR-0014 pattern). Opened from the applications directory. Shows
// the product's configuration (name, default audience), then its role catalogue, members, and credentials
// (all in ApplicationAccessSection). Delete routes through the audited server action — the service refuses
// (409) while the application still has credentials, surfaced as an error toast.

import { Drawer } from '@/components/ui/drawer';
import { ActionForm } from '@/components/action-form';
import { Hidden } from '@/components/field';
import { ApplicationAccessSection } from '@/components/application-access-section';
import { deleteApplication } from '@/app/actions';
import type { Application } from '@/lib/api';

export function ApplicationDetailDrawer({ application, onClose }: {
  application: Application;
  onClose: () => void;
}) {
  return (
    <Drawer
      ariaLabel={`Application ${application.name}`}
      title={application.name}
      subtitle={application._id}
      onClose={onClose}
      footer={
        <div className="ml-auto">
          <ActionForm action={deleteApplication} submitLabel="Delete" variant="destructive" confirm={`Delete application ${application.name}? Delete its credentials first — this fails otherwise.`} inline>
            <Hidden name="applicationId" value={application._id} />
          </ActionForm>
        </div>
      }
    >
      <div className="section">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Configuration</h3>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
          <dt className="text-muted-foreground">Application id</dt>
          <dd className="font-mono text-xs">{application._id}</dd>
          <dt className="text-muted-foreground">Audience</dt>
          <dd className="font-mono text-xs">{application.audience || '—'}</dd>
        </dl>
      </div>

      <ApplicationAccessSection applicationId={application._id} />
    </Drawer>
  );
}
