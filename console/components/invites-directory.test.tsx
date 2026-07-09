import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { InvitesDirectory } from '@/components/invites-directory';

vi.mock('@/app/actions', () => ({ createInvite: vi.fn(), revokeInvite: vi.fn(), fetchClientRoles: vi.fn().mockResolvedValue([]) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ADR-0019: every invite targets an application (clientId).
const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const invites = [
  { _id: 'inv_p', clientId: 'app_web', email: 'newhire@acme.example', roles: ['member'], maxUses: 1, usedCount: 0, expiresAt: future, status: 'pending', note: 'March cohort' },
  { _id: 'inv_r', clientId: 'app_web', email: null, roles: [], maxUses: 5, usedCount: 2, expiresAt: future, status: 'redeemed' },
  { _id: 'inv_x', clientId: 'app_api', email: null, roles: [], maxUses: 1, usedCount: 0, expiresAt: future, status: 'expired' },
];
const clients = [
  { _id: 'app_web', name: 'acme-web', grantTypes: [], scopes: [], roles: [{ key: 'member' }] },
];

const renderDirectory = () =>
  render(<InvitesDirectory invites={invites as never} clients={clients as never} />);

describe('InvitesDirectory', () => {
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
