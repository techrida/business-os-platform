import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

// F1-Q49: the VAT codes table's Server Actions open to settings.finance.write (Finance, Accountant) and
// admin.settings.write (the Founder), by live grant. Each persona's roles disagree with its grants.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('next/cache', () => ({ revalidatePath }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const master = vi.hoisted(() => ({
  createTaxCode: vi.fn(),
  changeTaxCode: vi.fn(),
  retireTaxCode: vi.fn(),
}));
vi.mock('@/lib/api-master-data', () => master);

const { addTaxCodeAction, changeTaxCodeAction, retireTaxCodeAction } = await import('./actions');

function persona(token: string, roles: string[], ...permissions: string[]): void {
  getMe.mockImplementation((asked) =>
    Promise.resolve(
      asked === token
        ? { permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }
        : {},
    ),
  );
  getSession.mockResolvedValue({ accessToken: token, orgKind: 'staff', roles } as Session);
}

const add = {
  code: 'vat15',
  name: 'VAT 15%',
  kind: 'vat',
  rate: '15',
  creditable: true,
  effectiveFrom: '2099-01-01',
};
const change = {
  name: 'VAT 15%',
  rate: '15',
  creditable: true,
  effectiveFrom: '2099-01-01',
  expectedPeriodId: '00000000-0000-4000-8000-000000000003',
  expectedVersion: 3,
};
const shown = { expectedPeriodId: '00000000-0000-4000-8000-000000000003', expectedVersion: 4 };

beforeEach(() => {
  vi.clearAllMocks();
  master.createTaxCode.mockResolvedValue({});
  master.changeTaxCode.mockResolvedValue({});
  master.retireTaxCode.mockResolvedValue({});
});

describe('tax code actions by live grant', () => {
  it('adds, changes and retires for a finance-settings grant held by a Sales role', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    await expect(addTaxCodeAction(add)).resolves.toMatchObject({ status: 'ok' });
    expect(master.createTaxCode).toHaveBeenCalledWith(expect.anything(), {
      ...add,
      code: 'VAT15',
    });
    await expect(changeTaxCodeAction('VAT13', change)).resolves.toMatchObject({ status: 'ok' });
    expect(master.changeTaxCode).toHaveBeenCalledWith(expect.anything(), 'VAT13', change);
    await expect(retireTaxCodeAction('VAT13', '2099-02-01', shown)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(master.retireTaxCode).toHaveBeenCalledWith(expect.anything(), 'VAT13', {
      effectiveTo: '2099-02-01',
      ...shown,
    });
  });

  it('refuses a Finance role whose live grants hold only exchange rates, before any call', async () => {
    persona('rates-only', ['finance'], 'settings.fx_rate.write');
    await expect(addTaxCodeAction(add)).rejects.toThrow('REDIRECT:/settings/currencies');
    await expect(changeTaxCodeAction('VAT13', change)).rejects.toThrow('REDIRECT:');
    await expect(retireTaxCodeAction('VAT13', '2099-02-01', shown)).rejects.toThrow('REDIRECT:');
    expect(master.createTaxCode).not.toHaveBeenCalled();
    expect(master.changeTaxCode).not.toHaveBeenCalled();
    expect(master.retireTaxCode).not.toHaveBeenCalled();
  });
});

describe('tax code action checks', () => {
  beforeEach(() => persona('founder-live', ['founder'], 'admin.settings.write'));

  it('refuses a rate that does not suit the kind without calling the API', async () => {
    const state = await addTaxCodeAction({ ...add, kind: 'exempt' });
    expect(state).toMatchObject({ status: 'error' });
    expect(state.message).toContain('0%');
    expect(master.createTaxCode).not.toHaveBeenCalled();
  });

  it('asks for a reload, without calling the API, when the screen sent no period id', async () => {
    const state = await changeTaxCodeAction('VAT13', { ...change, expectedPeriodId: '' });
    expect(state.status).toBe('error');
    expect(state.message).toContain('Reload the page');
    expect(master.changeTaxCode).not.toHaveBeenCalled();
  });

  it("shows the API's words for a refused change and refreshes the table", async () => {
    master.changeTaxCode.mockRejectedValue(
      new ApiError(409, 'POST failed', {
        error: {
          code: 'conflict',
          message: 'Someone else changed this tax code. Reload the page to see the latest version.',
          correlationId: 'c-1',
        },
      }),
    );
    const state = await changeTaxCodeAction('VAT13', change);
    expect(state).toMatchObject({
      status: 'error',
      message: 'Someone else changed this tax code. Reload the page to see the latest version.',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/settings/tax');
  });
});
