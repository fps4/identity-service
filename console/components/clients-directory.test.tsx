import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { ClientsDirectory } from '@/components/clients-directory';

vi.mock('@/app/actions', () => ({
  createClient: vi.fn(), rotateClientSecret: vi.fn(), deleteClient: vi.fn(),
}));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const tenants = [{ _id: 't1', name: 'Acme' }, { _id: 't2', name: 'Globex' }];
const clients = [
  { _id: 'cli_core', tenantId: 't1', name: 'core-api', grantTypes: ['client_credentials'], scopes: ['admin'], isConfidential: true },
  { _id: 'cli_web', tenantId: 't1', name: 'acme-web', grantTypes: ['authorization_code'], scopes: ['openid'], isConfidential: false, audience: 'acme-web' },
];

const renderDirectory = () =>
  render(<ClientsDirectory tenants={tenants} activeTenantId="t1" clients={clients as never} />);

describe('ClientsDirectory', () => {
  beforeEach(() => push.mockReset());

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

  it('navigates to ?tenantId= when the tenant is switched', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Tenant'), { target: { value: 't2' } });
    expect(push).toHaveBeenCalledWith('/clients?tenantId=t2');
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
