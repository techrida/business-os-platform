import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// F1-Q48: Finance or Accountant (settings.finance.write) open Tax, as does the Founder
// (admin.settings.write). Every persona's live grants differ from its role defaults, so these fail on a
// page that reads the roles instead of the grants.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/tax',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const master = vi.hoisted(() => ({
  listAdminTaxCodes: vi.fn(),
  createTaxCode: vi.fn(),
  changeTaxCode: vi.fn(),
  retireTaxCode: vi.fn(),
}));
vi.mock('@/lib/api-master-data', () => master);
const listTaxCodes = master.listAdminTaxCodes;
const listWithholdingCodes = vi.fn<() => unknown>();
vi.mock('@/lib/api-withholding-codes', () => ({
  listWithholdingCodes: () => listWithholdingCodes(),
}));
const admin = vi.hoisted(() => ({ getSetting: vi.fn(), putSetting: vi.fn() }));
vi.mock('@/lib/api-admin', () => admin);

const { default: TaxPage } = await import('./page');
const { saveSettingsPageAction } = await import('../_components/actions');

/** A staff session whose roles disagree with the live grants `/v1/me` reports for its token. */
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

const PERIOD = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'VAT 13%',
  rate: '13',
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2025-07-17',
  effectiveTo: null,
  version: 3,
};
const VAT13 = {
  code: 'VAT13',
  kind: 'vat',
  periods: [PERIOD],
  current: PERIOD,
  next: null,
  endsOn: null,
  latest: PERIOD,
};

const render = async () => renderToStaticMarkup((await TaxPage()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  listTaxCodes.mockResolvedValue([VAT13]);
  listWithholdingCodes.mockResolvedValue([]);
  admin.getSetting.mockResolvedValue({ key: 'tax.vat_rate', value: '13', version: 2 });
});

describe('the Tax page by live grant', () => {
  it('opens for a finance-settings grant held by a role without it by default', async () => {
    persona('finance-live', ['sales'], 'settings.finance.write');
    const html = await render();
    expect(html).toContain('VAT 13%');
    expect(html).toContain('13%');
    expect(html).toContain('Add tax code');
  });

  it('opens for admin.settings.write', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    expect(await render()).toContain('VAT codes');
  });

  it('refuses a Sales role with no settings grant, before any tax call', async () => {
    persona('sales', ['sales'], 'quotation.read', 'quotation.draft');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/denied');
    expect(listTaxCodes).not.toHaveBeenCalled();
  });

  it('sends an exchange-rate-only grant to Currencies, even for a Finance or Founder role', async () => {
    persona('rates-only', ['founder'], 'settings.fx_rate.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/currencies');
    persona('rates-only-finance', ['finance'], 'settings.fx_rate.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/currencies');
  });
});

// Round 5, UX1: nothing reads tax.vat_rate, so Kuu decided to hide its card. The key, its default and the
// save/reset actions stay (the save tests below still pass); only the page stops showing and reading it.
describe('the hidden default VAT rate', () => {
  it('shows no VAT rate card and never reads the setting, while the codes stay', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    const html = await render();
    expect(admin.getSetting).not.toHaveBeenCalled();
    expect(html).not.toContain('Default VAT rate');
    expect(html).not.toContain('name="v:tax.vat_rate"');
    expect(html).not.toContain('The default VAT rate');
    expect(html).toContain('VAT codes');
    expect(html).toContain('Withholding codes');
    expect(html).toContain('VAT 13%');
  });
});

describe('saving the default VAT rate by live grant', () => {
  const change = {
    key: 'tax.vat_rate' as const,
    value: { kind: 'text' as const, value: '12.5' },
    expectedVersion: 2,
  };

  it('writes it for a finance-settings grant held by a role without it by default', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    admin.putSetting.mockResolvedValue({ version: 3 });
    await expect(saveSettingsPageAction('tax', [change])).resolves.toMatchObject({
      status: 'ok',
    });
    expect(admin.putSetting).toHaveBeenCalledWith(expect.anything(), 'tax.vat_rate', '12.5', 2);
  });

  it('refuses a Finance role whose live grants hold only exchange rates, before any write', async () => {
    persona('rates-only-finance', ['finance'], 'settings.fx_rate.write');
    await expect(saveSettingsPageAction('tax', [change])).rejects.toThrow(
      'REDIRECT:/settings/currencies',
    );
    expect(admin.putSetting).not.toHaveBeenCalled();
  });
});
