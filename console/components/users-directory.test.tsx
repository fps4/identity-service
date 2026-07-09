import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { UsersDirectory } from '@/components/users-directory';

// Server actions can't run in jsdom — stub the module so importing the directory + drawer is safe. The
// user drawer's assignments section (ADR-0019) hydrates via fetchUserAssignments on mount, so it must
// resolve to an array.
vi.mock('@/app/actions', () => ({
  createUser: vi.fn(), resetPassword: vi.fn(), setUserStatus: vi.fn(),
  unlockUser: vi.fn(), deleteUser: vi.fn(), linkIdentity: vi.fn(), unlinkIdentity: vi.fn(),
  fetchUserAssignments: vi.fn().mockResolvedValue([]), fetchClientRoles: vi.fn().mockResolvedValue([]),
  assignUser: vi.fn(), updateAssignment: vi.fn(), revokeAssignment: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ADR-0019: users carry no deployment-wide roles anymore (access is per-application via assignments).
const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const users = [
  { _id: 'usr_active', email: 'dana@acme.example', status: 'active' },
  { _id: 'usr_disabled', email: 'kim@acme.example', status: 'disabled' },
  { _id: 'usr_locked', email: 'sam@acme.example', status: 'active', failedAttempts: 5, lockedUntil: future },
];

const renderDirectory = () =>
  render(<UsersDirectory users={users as never} />);

describe('UsersDirectory', () => {
  it('lists every user with a count', () => {
    renderDirectory();
    expect(screen.getByText('dana@acme.example')).toBeInTheDocument();
    expect(screen.getByText('kim@acme.example')).toBeInTheDocument();
    expect(screen.getByText('sam@acme.example')).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('derives a Locked badge from lockedUntil in the future', () => {
    renderDirectory();
    const row = screen.getByText('sam@acme.example').closest('tr')!;
    expect(within(row).getByText('Locked')).toBeInTheDocument();
    expect(within(row).getByText('5 failed')).toBeInTheDocument();
  });

  it('narrows the list by search query without refetching', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'sam' } });
    expect(screen.getByText('sam@acme.example')).toBeInTheDocument();
    expect(screen.queryByText('dana@acme.example')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('filters by status (locked)', () => {
    renderDirectory();
    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'locked' } });
    expect(screen.getByText('sam@acme.example')).toBeInTheDocument();
    expect(screen.queryByText('dana@acme.example')).not.toBeInTheDocument();
    expect(screen.queryByText('kim@acme.example')).not.toBeInTheDocument();
  });

  it('opens a detail drawer with contextual actions when a row is selected', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('sam@acme.example'));
    const drawer = screen.getByRole('dialog', { name: /User sam@acme.example/ });
    // Locked user → the drawer offers Unlock; every user offers reset + disable.
    expect(within(drawer).getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Disable account' })).toBeInTheDocument();
  });

  it('does not offer Unlock for a user who is not locked', () => {
    renderDirectory();
    fireEvent.click(screen.getByText('dana@acme.example'));
    const drawer = screen.getByRole('dialog', { name: /User dana@acme.example/ });
    expect(within(drawer).queryByRole('button', { name: 'Unlock' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Disable account' })).toBeInTheDocument();
  });
});
