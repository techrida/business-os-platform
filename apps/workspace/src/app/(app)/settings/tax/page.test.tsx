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

const { default: TaxPage } = await import('./page');

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
