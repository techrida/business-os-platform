import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

import { testCatalogue } from './_lib/test-catalogue';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const api = vi.hoisted(() => ({
  getAccessCatalogue: vi.fn(),
  previewAccessChanges: vi.fn(),
  saveAccessChanges: vi.fn(),
}));
vi.mock('@/lib/api-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-access')>()),
  ...api,
}));
vi.mock('@/components/access/review-changes-dialog', () => ({
  ReviewChangesDialog: () => null,
}));

const { default: RolesPage } = await import('./page');
const { default: RolePage } = await import('./[role]/page');
const { ApiError } = await import('@/lib/api');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;
const rolePage = (role: string) => RolePage({ params: Promise.resolve({ role }) });
const html = async (node: Promise<unknown>) => renderToStaticMarkup((await node) as ReactElement);

beforeEach(() => {
  getSession.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getAccessCatalogue.mockResolvedValue(testCatalogue());
});

describe('By role pages', () => {
  it('send a person without access to the denied page before reading anything', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(RolesPage()).rejects.toThrow('REDIRECT:/settings/denied');
    await expect(rolePage('sales')).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.getAccessCatalogue).not.toHaveBeenCalled();
  });

  it('send a signed-out visitor to sign in and back to the role page', async () => {
    getSession.mockResolvedValue(null);
    await expect(rolePage('sales')).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Fsettings%2Faccess%2Froles%2Fsales',
    );
  });

  it('list every role the API returns, each with its people count, Portal apart', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const page = await html(RolesPage());
    for (const label of [
      'Founder',
      'Management',
      'Operations head',
      'Sales',
      'Customer portal user',
      'Vendor portal user',
    ]) {
      expect(page).toContain(label);
    }
    expect(page).toContain('6 people');
    expect(page).toContain('1 person');
    expect(page).toContain('>Portal</h2>');
    expect(page).toContain('href="/settings/access/roles/operations_head"');
    expect(page).not.toContain('Permission scope by role (defaults)');
  });

  it('mark the open role and its edited state, with groups anchored by area', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const page = await html(rolePage('sales'));
    expect(page).toMatch(/aria-current="page"[^>]*href="\/settings\/access\/roles\/sales"|href="\/settings\/access\/roles\/sales"[^>]*aria-current="page"/);
    expect(page).toContain('Edited');
    expect(page).toContain('id="leads"');
    expect(page).toContain('Finds customers and prepares quotations.');
    expect(page).toContain('href="/settings/users?role=sales"');
  });

  it('answer an unknown role with not found', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(rolePage('nobody')).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(rolePage('marketing')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('show the plain load error with Try again when the catalogue fails', async () => {
    getSession.mockResolvedValue(session(['founder']));
    api.getAccessCatalogue.mockRejectedValue(new ApiError(500, 'boom'));
    const page = await html(rolePage('sales'));
    expect(page).toContain('Access settings could not load. Try again in a moment.');
    expect(page).toContain('Try again');
    expect(page).not.toContain('API');

    api.getAccessCatalogue.mockRejectedValue(new ApiError(403, 'no'));
    expect(await html(RolesPage())).toContain(
      "You don&#x27;t have permission to view access settings.",
    );
  });
});
