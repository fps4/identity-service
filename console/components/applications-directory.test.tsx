import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { ApplicationsDirectory } from '@/components/applications-directory';

// ADR-0020: the application is the top-level product. Its detail drawer hydrates the role catalogue,
// members, and credentials via the fetch* actions on mount, so each must resolve to data.
vi.mock('@/app/actions', () => ({
  createApplication: vi.fn(), deleteApplication: vi.fn(),
  fetchApplicationRoles: vi.fn().mockResolvedValue([{ key: 'admin', name: 'Admin' }, { key: 'member', name: 'Member' }]),
  fetchApplicationMembers: vi.fn().mockResolvedValue([{ userId: 'u1', email: 'dana@acme.example', userStatus: 'active', status: 'active', roles: ['member'] }]),
  fetchApplicationCredentials: vi.fn().mockResolvedValue([{ _id: 'cli_web', applicationId: 'app_web', name: 'web-login', grantTypes: ['authorization_code'], scopes: [], isConfidential: false }]),
  setApplicationRoles: vi.fn(), assignUser: vi.fn(), updateAssignment: vi.fn(), revokeAssignment: vi.fn(),
  createClient: vi.fn(), rotateClientSecret: vi.fn(), deleteClient: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const applications = [
  { _id: 'app_web', name: 'acme-web', audience: 'aud-acme-web', roles: [{ key: 'admin', name: 'Admin' }, { key: 'member', name: 'Member' }] },
  { _id: 'app_api', name: 'core-api', roles: [] },
];

const renderDirectory = () =>
  render(<ApplicationsDirectory applications={applications as never} />);

describe('ApplicationsDirectory', () => {
  it('lists applications with their audience, roles and a count', () => {
    renderDirectory();
    expect(screen.getByText('acme-web')).toBeInTheDocument();
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    const webRow = screen.getByText('acme-web').closest('tr')!;
    expect(within(webRow).getByText('admin, member')).toBeInTheDocument();
  });

  it('narrows by search', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Search applications'), { target: { value: 'core' } });
    expect(screen.getByText('core-api')).toBeInTheDocument();
    expect(screen.queryByText('acme-web')).not.toBeInTheDocument();
  });

  it('opens a detail drawer exposing the role-catalogue editor, members and credentials', async () => {
    renderDirectory();
    fireEvent.click(screen.getByText('acme-web'));
    const drawer = screen.getByRole('dialog', { name: /Application acme-web/ });

    // Role catalogue + members + credentials hydrate asynchronously from the mocked fetch* actions.
    expect(await within(drawer).findByText('dana@acme.example')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Save catalogue' })).toBeInTheDocument();
    expect(within(drawer).getByText('Role catalogue')).toBeInTheDocument();
    expect(within(drawer).getByText('Members')).toBeInTheDocument();
    expect(within(drawer).getByText('web-login')).toBeInTheDocument();
    expect(within(drawer).getByText('Credentials')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Add credential' })).toBeInTheDocument();
  });

  it('create-application collects a name, audience and role keys', () => {
    renderDirectory();
    fireEvent.click(screen.getByRole('button', { name: 'Create application' }));
    const dialog = screen.getByRole('dialog', { name: 'Create application' });
    expect(within(dialog).getByLabelText('Name')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Default audience')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Role catalogue keys (comma)')).toBeInTheDocument();
  });
});
