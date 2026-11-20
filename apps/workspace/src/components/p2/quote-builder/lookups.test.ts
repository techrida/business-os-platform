import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

import { loadLookups } from './lookups';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ listContacts: vi.fn(), listPaymentTerms: vi.fn() }));
const tax = vi.hoisted(() => ({ listTaxCodes: vi.fn() }));
const presets = vi.hoisted(() => ({ listTermPresets: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('@/lib/api-tax-codes', () => tax);
vi.mock('@/lib/api-term-presets', () => presets);
const getMe = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>(),
);
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));

const session = { accessToken: 'sales', roles: ['sales'] } as Session;

/** A session whose roles disagree with the live grants `/v1/me` reports for its token. */
const persona = (token: string, roles: string[], ...permissions: string[]): Session => {
  getMe.mockImplementation((asked) =>
    Promise.resolve(
      asked === token
        ? { permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }
        : {},
    ),
  );
  return { accessToken: token, roles } as Session;
};
const code = { id: '11111111-1111-4111-8111-111111111111', label: 'VAT 13%', rate: '13' };

beforeEach(() => {
  vi.clearAllMocks();
  api.listPaymentTerms.mockResolvedValue([]);
  api.listContacts.mockResolvedValue([]);
  presets.listTermPresets.mockResolvedValue([]);
  // Unless a test says otherwise /v1/me is down, so the role defaults decide.
  getMe.mockRejectedValue(new Error('upstream down'));
});

describe('loadLookups', () => {
  it('loads quotation taxes through the shared registry with the staff session', async () => {
    tax.listTaxCodes.mockResolvedValue([code]);
    expect((await loadLookups(session, 'customer')).taxCodes).toEqual([code]);
    expect(tax.listTaxCodes).toHaveBeenCalledWith(session);
  });

  it('keeps a failed tax lookup distinct from an empty list without losing other lookups', async () => {
    tax.listTaxCodes.mockRejectedValue(new Error('unavailable'));
    expect(await loadLookups(session, 'customer')).toEqual({
      taxCodes: null,
      paymentTerms: [],
      contacts: [],
      termPresets: [],
      canAddTerms: false,
    });
    tax.listTaxCodes.mockResolvedValue([]);
    expect((await loadLookups(session, 'customer')).taxCodes).toEqual([]);
  });

  it('loads saved terms with the staff session', async () => {
    const preset = {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'scope',
      name: 'Standard',
      body: 'We build it.',
    };
    tax.listTaxCodes.mockResolvedValue([]);
    presets.listTermPresets.mockResolvedValue([preset]);
    expect((await loadLookups(session, 'customer')).termPresets).toEqual([preset]);
    expect(presets.listTermPresets).toHaveBeenCalledWith(session);
  });

  it('degrades to no saved terms when the call is refused (403) or fails, without losing the rest', async () => {
    tax.listTaxCodes.mockResolvedValue([code]);
    presets.listTermPresets.mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 }),
    );
    const result = await loadLookups(session, 'customer');
    expect(result.termPresets).toBeNull();
    expect(result.taxCodes).toEqual([code]);
    expect(result.paymentTerms).toEqual([]);
  });

  it('offers "Add more" for a live finance-settings or admin.settings.write grant, whatever the roles', async () => {
    tax.listTaxCodes.mockResolvedValue([]);
    const finance = persona('finance-live', ['sales'], 'settings.finance.write');
    expect((await loadLookups(finance, 'customer')).canAddTerms).toBe(true);
    const founder = persona('founder-live', ['sales'], 'admin.settings.write');
    expect((await loadLookups(founder, 'customer')).canAddTerms).toBe(true);
  });

  it('withholds "Add more" when the live grants lack both, even from a Founder role', async () => {
    tax.listTaxCodes.mockResolvedValue([]);
    const narrowed = persona('founder-narrowed', ['founder'], 'settings.fx_rate.write');
    expect((await loadLookups(narrowed, 'customer')).canAddTerms).toBe(false);
    const sales = persona('sales-live', ['sales'], 'quotation.draft');
    expect((await loadLookups(sales, 'customer')).canAddTerms).toBe(false);
  });

  it('falls back to the role defaults when /v1/me is down', async () => {
    tax.listTaxCodes.mockResolvedValue([]);
    const founder = { accessToken: 'founder', roles: ['founder'] } as Session;
    expect((await loadLookups(founder, 'customer')).canAddTerms).toBe(true);
    expect((await loadLookups(session, 'customer')).canAddTerms).toBe(false);
    const none = { accessToken: 'none', roles: [] } as unknown as Session;
    expect((await loadLookups(none, 'customer')).canAddTerms).toBe(false);
  });
});
