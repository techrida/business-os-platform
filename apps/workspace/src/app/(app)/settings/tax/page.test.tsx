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
const listTaxCodes = vi.fn<() => unknown>();
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: () => listTaxCodes() }));
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

const render = async () => renderToStaticMarkup((await TaxPage()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  listTaxCodes.mockResolvedValue([{ id: 'v13', label: 'VAT 13%', code: 'VAT13', rateBp: 1300 }]);
  listWithholdingCodes.mockResolvedValue([]);
  admin.getSetting.mockResolvedValue({ key: 'tax.vat_rate', value: '13', version: 2 });
});

describe('the Tax page by live grant', () => {
  it('opens for a finance-settings grant held by a role without it by default', async () => {
    persona('finance-live', ['sales'], 'settings.finance.write');
    const html = await render();
    expect(html).toContain('VAT 13%');
    expect(html).toContain('13.00%');
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

// F1-Q48: CARD_KEYS.tax names tax.vat_rate, but the page never rendered it, so nobody could change it.
describe('the default VAT rate card', () => {
  it('shows the saved rate as a typed percent field to a finance-settings grant', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    admin.getSetting.mockResolvedValue({ key: 'tax.vat_rate', value: '12.5', version: 4 });
    const html = await render();
    expect(admin.getSetting).toHaveBeenCalledWith(expect.anything(), 'tax.vat_rate');
    expect(html).toContain('Default VAT rate (%)');
    const input = html.match(/<input[^>]*name="v:tax\.vat_rate"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('type="number"');
    expect(input).toContain('value="12.5"');
  });

  it('keeps the codes when the rate cannot be read', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    admin.getSetting.mockRejectedValue(new Error('down'));
    const html = await render();
    expect(html).not.toContain('Default VAT rate (%)');
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
