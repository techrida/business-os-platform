import type { AccessCatalogueResponse } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// The "Last changed ... · View history" line on Access > By area (spec 4).
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
type LiveGrants = { permissions: { permission: string; scope: string }[] };
const kernel = vi.hoisted(() => ({ getMe: vi.fn<(session: unknown) => Promise<LiveGrants>>() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...kernel,
}));
const access = vi.hoisted(() => ({
  getAccessCatalogue: vi.fn<(session: Session) => Promise<AccessCatalogueResponse>>(),
  listAccessPeople: vi.fn<(session: Session) => Promise<[]>>(),
  listActiveDepartmentsForAccess: vi.fn<(session: Session) => Promise<{ items: [] }>>(),
}));
vi.mock('@/lib/api-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-access')>()),
  ...access,
}));
// The cards and their actions are not under test here.
vi.mock('@/components/access/area-cards', () => ({ AreaCards: () => null }));
vi.mock('../actions', () => ({
  checkWithChangesAction: vi.fn(),
  previewAccessAction: vi.fn(),
  saveAccessAction: vi.fn(),
}));

const { default: AccessByAreaPage } = await import('../page');

let token = 0;
const session = (): Session =>
  ({ accessToken: `link${++token}`, orgKind: 'staff', roles: ['founder'] }) as Session;

const grants = (...permissions: string[]): LiveGrants => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

const catalogue = (lastChanged: AccessCatalogueResponse['lastChanged']) =>
  ({ revision: 'r1', lastChanged }) as unknown as AccessCatalogueResponse;

const CHANGED = { at: '2026-11-18T09:30:00.000Z', byName: 'Asha K.' };

const render = async () =>
  renderToStaticMarkup(
    (await AccessByAreaPage({ searchParams: Promise.resolve({}) })) as ReactElement,
  );

beforeEach(() => {
  getSession.mockReset();
  kernel.getMe.mockReset();
  for (const fn of Object.values(access)) fn.mockReset();
  getSession.mockImplementation(() => Promise.resolve(session()));
  kernel.getMe.mockResolvedValue(grants('admin.roles.read', 'admin.roles.write', 'audit.read'));
  access.getAccessCatalogue.mockResolvedValue(catalogue(CHANGED));
  access.listAccessPeople.mockResolvedValue([]);
  access.listActiveDepartmentsForAccess.mockResolvedValue({ items: [] });
});

describe('Access > By area, last changed line', () => {
  it('links to the access history for a person with audit.read', async () => {
    const page = await render();

    expect(page).toContain('by Asha K.');
    expect(page).toMatch(/<a [^>]*href="\/settings\/access\/history"[^>]*>View history<\/a>/);
  });

  it('hides the link without the live audit.read grant', async () => {
    kernel.getMe.mockResolvedValue(grants('admin.roles.read'));

    const page = await render();

    expect(page).toContain('by Asha K.');
    expect(page).not.toContain('View history');
    expect(page).not.toContain('/settings/access/history');
  });

  it('shows no line and no link when access was never changed', async () => {
    access.getAccessCatalogue.mockResolvedValue(catalogue(null));

    const page = await render();

    expect(page).not.toContain('Last changed');
    expect(page).not.toContain('View history');
  });
});
