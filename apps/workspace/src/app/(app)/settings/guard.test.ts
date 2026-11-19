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

const { requireSection } = await import('./guard');

const session = (roles: string[], orgKind: Session['orgKind'] = 'staff'): Session =>
  ({ accessToken: 't', orgKind, roles }) as Session;

beforeEach(() => getSession.mockReset());

describe('requireSection', () => {
  it('lets the founder into every ready section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    for (const id of [
      'users',
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

  it('refuses a sales user on every section (nothing else to open, so no-access)', async () => {
    getSession.mockResolvedValue(session(['sales']));
    for (const id of [
      'users',
      'roles',
      'workflows',
      'currencies',
      'tax',
      'numbering',
      'sales',
      'purchasing',
    ] as const) {
      await expect(requireSection(id)).rejects.toThrow('REDIRECT:/no-access');
    }
  });

  it('refuses an unknown or role-less session', async () => {
    getSession.mockResolvedValue(session([]));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/no-access');
    getSession.mockResolvedValue(session(['not-a-role']));
    await expect(requireSection('users')).rejects.toThrow('REDIRECT:/no-access');
  });
});
