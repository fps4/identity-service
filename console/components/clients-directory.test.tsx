import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { ClientsDirectory } from '@/components/clients-directory';

// A credential is a leaf under an application (ADR-0020): the drawer no longer has a role catalogue or
// members — just config (incl. the application) + secret. Only the client server actions are used.
vi.mock('@/app/actions', () => ({
  createClient: vi.fn(), rotateClientSecret: vi.fn(), deleteClient: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const applications = [
  { _id: 'app_core', name: 'core-product', roles: [{ key: 'admin', name: 'Admin' }] },
  { _id: 'app_web', name: 'acme-web', roles: [] },
];
const clients = [
  { _id: 'cli_core', applicationId: 'app_core', name: 'core-api', grantTypes: ['client_credentials'], scopes: ['admin'], isConfidential: true },
  { _id: 'cli_web', applicationId: 'app_web', name: 'acme-web-login', grantTypes: ['authorization_code'], scopes: ['openid'], isConfidential: false, audience: 'acme-web' },
];

const renderDirectory = () =>
  render(<ClientsDirectory clients={clients as never} applications={applications as never} />);

describe('ClientsDirectory', () => {
  it('lists credentials with their application, a type badge and a count', () => {
    renderDirectory();
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.getByText('acme-web-login')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    const coreRow = screen.getByText('core-api').closest('tr')!;
    expect(within(coreRow).getByText('Confidential')).toBeInTheDocument();
    expect(within(coreRow).getByText('core-product')).toBeInTheDocument();
    const webRow = screen.getByText('acme-web-login').closest('tr')!;
    expect(within(webRow).getByText('Public / PKCE')).toBeInTheDocument();
  });

  it('narrows by search', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Search credentials'), { target: { value: 'core-api' } });
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.queryByText('acme-web-login')).not.toBeInTheDocument();
  });

  it('offers Rotate secret only for a confidential client', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('core-api'));
    const drawer = screen.getByRole('dialog', { name: /Credential core-api/ });
    expect(within(drawer).getByRole('button', { name: 'Rotate secret' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides Rotate secret for a public client and shows its application', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('acme-web-login'));
    const drawer = screen.getByRole('dialog', { name: /Credential acme-web-login/ });
    expect(within(drawer).queryByRole('button', { name: 'Rotate secret' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    // The drawer shows the credential's application (name + id).
    expect(within(drawer).getByText('app_web')).toBeInTheDocument();
  });

  it('register-credential requires choosing an application', () => {
    renderDirectory();
    fireEvent.click(screen.getByRole('button', { name: 'Register credential' }));
    const dialog = screen.getByRole('dialog', { name: 'Register credential' });
    expect(within(dialog).getByLabelText('Application')).toBeInTheDocument();
  });
});
