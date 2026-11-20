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

const { requireSection } = await import('./guard');

const session = (roles: string[], orgKind: Session['orgKind'] = 'staff'): Session =>
  ({ accessToken: 't', orgKind, roles }) as Session;

const live = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

beforeEach(() => {
  getSession.mockReset();
  getMe.mockReset();
  // Unless a test says otherwise /v1/me is down, so the role defaults decide.
  getMe.mockRejectedValue(new Error('upstream down'));
});

describe('requireSection', () => {
  it('lets the founder into every ready section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    for (const id of [
      'users',
      'departments',
      'roles',
      'workflows',
      'currencies',
      'tax',
      'numbering',
      'sales',
      'purchasing',
    ] as const) {
      await expect(requireSection(id)).resolves.toMatchObject({ roles: ['founder'] });
    }
  });

  it('sends a signed-out visitor to sign in, returning to the section', async () => {
    getSession.mockResolvedValue(null);
    await expect(requireSection('tax')).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Fsettings%2Ftax',
    );
  });

  it('keeps customers and vendors out', async () => {
    getSession.mockResolvedValue(session(['founder'], 'customer'));
    await expect(requireSection('tax')).rejects.toThrow('REDIRECT:/staff-only');
  });

  it('refuses a sales user on every section (nothing else to open, so the denied page)', async () => {
    getSession.mockResolvedValue(session(['sales']));
    for (const id of [
      'users',
      'departments',
      'roles',
      'workflows',
      'currencies',
      'tax',
      'numbering',
      'sales',
      'purchasing',
    ] as const) {
      await expect(requireSection(id)).rejects.toThrow('REDIRECT:/settings/denied');
    }
  });

  it('refuses an unknown or role-less session', async () => {
    getSession.mockResolvedValue(session([]));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/settings/denied');
    getSession.mockResolvedValue(session(['not-a-role']));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/settings/denied');
  });

  it('opens a section for a non-Founder role granted its permission in Settings > Access', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('customer.read', 'admin.users.read'));
    await expect(requireSection('users')).resolves.toMatchObject({ roles: ['sales'] });
    getMe.mockResolvedValue(live('admin.settings.write'));
    await expect(requireSection('tax')).resolves.toMatchObject({ roles: ['sales'] });
  });

  it('refuses that role without the grant, sending it to a section it may open', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('customer.read'));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/settings/denied');
    getMe.mockResolvedValue(live('admin.users.read'));
    await expect(requireSection('tax')).rejects.toThrow('REDIRECT:/settings/users');
  });

  it('follows the live grants over the role defaults when a grant was removed', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getMe.mockResolvedValue(live('admin.users.read'));
    await expect(requireSection('tax')).rejects.toThrow('REDIRECT:/settings/users');
  });

  it('falls back to the role defaults when /v1/me fails or sends no grant list', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(requireSection('users')).resolves.toMatchObject({ roles: ['founder'] });
    getSession.mockResolvedValue(session(['sales']));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/settings/denied');
    getMe.mockResolvedValue({});
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/settings/denied');
    getSession.mockResolvedValue(session(['founder']));
    await expect(requireSection('users')).resolves.toMatchObject({ roles: ['founder'] });
  });
});
