import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { InvitesDirectory } from '@/components/invites-directory';

vi.mock('@/app/actions', () => ({ createInvite: vi.fn(), revokeInvite: vi.fn() }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const tenants = [{ _id: 't1', name: 'Acme' }, { _id: 't2', name: 'Globex' }];
const invites = [
  { _id: 'inv_p', tenantId: 't1', email: 'newhire@acme.example', roles: ['member'], maxUses: 1, usedCount: 0, expiresAt: future, status: 'pending', note: 'March cohort' },
  { _id: 'inv_r', tenantId: 't1', email: null, roles: [], maxUses: 5, usedCount: 2, expiresAt: future, status: 'redeemed' },
  { _id: 'inv_x', tenantId: 't1', email: null, roles: [], maxUses: 1, usedCount: 0, expiresAt: future, status: 'expired' },
];

const renderDirectory = () =>
  render(<InvitesDirectory tenants={tenants} activeTenantId="t1" invites={invites as never} />);

describe('InvitesDirectory', () => {
  beforeEach(() => push.mockReset());

  it('lists invites with status badges and a count', () => {
    renderDirectory();
    expect(screen.getByText('newhire@acme.example')).toBeInTheDocument();
    expect(screen.getAllByText('Any email')).toHaveLength(2);
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
    const pendingRow = screen.getByText('newhire@acme.example').closest('tr')!;
    expect(within(pendingRow).getByText('Pending')).toBeInTheDocument();
  });

  it('filters by status', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'pending' } });
    expect(screen.getByText('newhire@acme.example')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('searches by email or note', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Search invites'), { target: { value: 'march' } });
    expect(screen.getByText('newhire@acme.example')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('navigates to ?tenantId= when the tenant is switched', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 't2' } });
    expect(push).toHaveBeenCalledWith('/invites?tenantId=t2');
  });

  it('offers Revoke only for a pending invite', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('newhire@acme.example'));
    const drawer = screen.getByRole('dialog', { name: /Invite inv_p/ });
    expect(within(drawer).getByRole('button', { name: 'Revoke invite' })).toBeInTheDocument();
  });

  it('shows no actions for a non-pending invite', () => {
    renderDirectory();
    fireEvent.click(screen.getAllByText('Any email')[0]); // inv_r (redeemed)
    const drawer = screen.getByRole('dialog', { name: /Invite inv_r/ });
    expect(within(drawer).queryByRole('button', { name: 'Revoke invite' })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/No actions/)).toBeInTheDocument();
  });
});
