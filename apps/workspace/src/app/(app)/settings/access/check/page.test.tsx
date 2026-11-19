import { CheckPersonReportSchema, type CheckPersonReport } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const api = vi.hoisted(() => ({
  checkPersonAccess: vi.fn(),
  listAccessPeople: vi.fn(),
  previewAccessChanges: vi.fn(),
  saveAccessChanges: vi.fn(),
  getAccessCatalogue: vi.fn(),
}));
vi.mock('@/lib/api-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-access')>()),
  ...api,
}));

const { default: CheckPersonPage } = await import('./page');
const { ApiError } = await import('@/lib/api');

const ASHA = '00000000-0000-4000-8000-0000000000a1';
const BIBEK = '00000000-0000-4000-8000-0000000000b2';
const SALES_DEPT = '00000000-0000-4000-8000-0000000000d1';

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

function report(over: Partial<CheckPersonReport['person']> = {}): CheckPersonReport {
  return CheckPersonReportSchema.parse({
    person: {
      id: ASHA,
      name: 'Asha K.',
      email: 'asha@example.com',
      status: 'active',
      roles: [{ key: 'sales', label: 'Sales' }],
      department: { id: SALES_DEPT, name: 'Sales' },
      level: 'manager',
      ...over,
    },
    areas: [
      {
        area: 'leads',
        label: 'Leads',
        scope: 'department',
        scopeLabel: 'Their department',
        visibleCount: 48,
        totalCount: 120,
        actions: [{ permission: 'crm.lead.write', label: 'Create and edit leads', scope: 'own' }],
        assignableCount: 1,
        assignablePeople: [
          { userId: BIBEK, name: 'Bibek R.', departmentName: 'Sales', level: 'staff' },
        ],
        why: ['Sales role gives Their own.', 'Manager level adds Their department.'],
      },
      {
        area: 'invoices',
        label: 'Invoices',
        scope: null,
        scopeLabel: 'Nothing',
        visibleCount: 0,
        totalCount: 30,
        actions: [],
        assignableCount: null,
        why: ['No role gives invoices.'],
      },
    ],
  });
}

const render = async (params: Record<string, string>) =>
  renderToStaticMarkup(
    (await CheckPersonPage({ searchParams: Promise.resolve(params) })) as ReactElement,
  );

beforeEach(() => {
  getSession.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  getSession.mockResolvedValue(session(['founder']));
  api.listAccessPeople.mockResolvedValue([
    {
      id: ASHA,
      name: 'Asha K.',
      email: 'asha@example.com',
      status: 'active',
      roles: ['sales'],
      departmentName: 'Sales',
    },
  ]);
  api.checkPersonAccess.mockResolvedValue(report());
});

describe('Check a person', () => {
  it('sends a person without access to the denied page before reading anything', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(render({ person: ASHA })).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.checkPersonAccess).not.toHaveBeenCalled();
    expect(api.listAccessPeople).not.toHaveBeenCalled();
  });

  it('asks for a person when none, or no valid one, is in the address', async () => {
    for (const params of [{}, { person: 'asha' }]) {
      const page = await render(params);
      expect(page).toContain('Pick a person to see what they can open.');
    }
    expect(api.checkPersonAccess).not.toHaveBeenCalled();
  });

  it('reports each area with reach, count, actions, assignees, why and a link to change it', async () => {
    const page = await render({ person: ASHA });
    expect(api.checkPersonAccess).toHaveBeenCalledWith(expect.anything(), ASHA);
    expect(page).toContain('Asha K. · Sales · Manager in Sales · Active');
    expect(page).toContain('Their department');
    expect(page).toContain('48 of 120');
    expect(page).toContain('Create and edit leads');
    expect(page).toContain('1 person');
    expect(page).toContain('Manager level adds Their department.');
    expect(page).toContain('href="/settings/access?area=leads"');
    expect(page).toContain('href="/settings/access?area=invoices"');
    expect(page).toContain('Nothing else');
  });

  it('writes nothing and signs nobody in while reporting', async () => {
    await render({ person: ASHA });
    expect(api.previewAccessChanges).not.toHaveBeenCalled();
    expect(api.saveAccessChanges).not.toHaveBeenCalled();
  });

  it('says when the person is disabled, and when they have no roles shows no rows', async () => {
    api.checkPersonAccess.mockResolvedValue(report({ status: 'inactive' }));
    expect(await render({ person: ASHA })).toContain(
      'Asha K. is disabled and cannot sign in. This shows what their roles would allow.',
    );

    api.checkPersonAccess.mockResolvedValue(report({ roles: [] }));
    const page = await render({ person: ASHA });
    expect(page).toContain('Asha K. has no roles, so they cannot open anything.');
    expect(page).not.toContain('48 of 120');
  });

  it('says plainly when the person is not found, and when the read fails', async () => {
    api.checkPersonAccess.mockRejectedValue(new ApiError(404, 'missing'));
    expect(await render({ person: ASHA })).toContain('This person could not be found.');

    api.checkPersonAccess.mockRejectedValue(new ApiError(500, 'boom'));
    const page = await render({ person: ASHA });
    expect(page).toContain('Access settings could not load. Try again in a moment.');
    expect(page).not.toContain('API');
  });

  it('still reports a person reached by a link when the people list is empty', async () => {
    api.listAccessPeople.mockResolvedValue([]);
    const page = await render({ person: ASHA });
    expect(page).toContain('Asha K. · Sales · Manager in Sales · Active');
  });
});
