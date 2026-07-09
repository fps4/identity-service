import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { ClientsDirectory } from '@/components/clients-directory';

// The client drawer's access section (ADR-0019) hydrates via fetchClientRoles + fetchClientMembers on
// mount, so both must resolve to arrays.
vi.mock('@/app/actions', () => ({
  createClient: vi.fn(), rotateClientSecret: vi.fn(), deleteClient: vi.fn(),
  fetchClientRoles: vi.fn().mockResolvedValue([]), fetchClientMembers: vi.fn().mockResolvedValue([]),
  setClientRoles: vi.fn(), assignUser: vi.fn(), updateAssignment: vi.fn(), revokeAssignment: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const clients = [
  { _id: 'cli_core', name: 'core-api', grantTypes: ['client_credentials'], scopes: ['admin'], isConfidential: true, roles: [{ key: 'admin', name: 'Admin' }] },
  { _id: 'cli_web', name: 'acme-web', grantTypes: ['authorization_code'], scopes: ['openid'], isConfidential: false, audience: 'acme-web', roles: [] },
];

const renderDirectory = () =>
  render(<ClientsDirectory clients={clients as never} />);

describe('ClientsDirectory', () => {
  it('lists applications with a type badge and a count', () => {
    renderDirectory();
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.getByText('acme-web')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    const coreRow = screen.getByText('core-api').closest('tr')!;
    expect(within(coreRow).getByText('Confidential')).toBeInTheDocument();
    const webRow = screen.getByText('acme-web').closest('tr')!;
    expect(within(webRow).getByText('Public / PKCE')).toBeInTheDocument();
  });

  it('narrows by search', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Search applications'), { target: { value: 'core' } });
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.queryByText('acme-web')).not.toBeInTheDocument();
  });

  it('offers Rotate secret only for a confidential client', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('core-api'));
    const drawer = screen.getByRole('dialog', { name: /Application core-api/ });
    expect(within(drawer).getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides Rotate secret for a public client', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('acme-web'));
    const drawer = screen.getByRole('dialog', { name: /Application acme-web/ });
    expect(within(drawer).queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
