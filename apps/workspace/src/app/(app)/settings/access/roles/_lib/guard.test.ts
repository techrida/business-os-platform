import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe = vi.fn<() => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', () => ({ getMe: () => getMe() }));

const { requireAccess } = await import('./guard');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;
const live = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

beforeEach(() => {
  getSession.mockReset();
  getMe.mockReset();
  getMe.mockRejectedValue(new Error('upstream down'));
});

describe('requireAccess', () => {
  it('lets a non-Founder role granted admin.roles.read look, without writing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('admin.roles.read'));
    await expect(requireAccess('/settings/access/roles')).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it('refuses that role without the grant', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('customer.read'));
    await expect(requireAccess('/settings/access/roles')).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
  });

  it('keeps writing Founder-only, whatever the live grants say', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('admin.roles.read', 'admin.roles.write'));
    await expect(requireAccess('/settings/access/roles')).resolves.toMatchObject({
      canWrite: false,
    });
  });

  it('falls back to the role defaults when /v1/me fails', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(requireAccess('/settings/access/roles')).resolves.toMatchObject({
      canWrite: true,
    });
    getSession.mockResolvedValue(session(['sales']));
    await expect(requireAccess('/settings/access/roles')).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
  });
});
