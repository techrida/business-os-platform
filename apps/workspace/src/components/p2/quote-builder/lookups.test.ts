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

const session = { roles: ['sales'] } as Session;
const code = { id: '11111111-1111-4111-8111-111111111111', label: 'VAT 13%', rate: '13' };

beforeEach(() => {
  vi.clearAllMocks();
  api.listPaymentTerms.mockResolvedValue([]);
  api.listContacts.mockResolvedValue([]);
  presets.listTermPresets.mockResolvedValue([]);
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

  it('offers "Add more" to a session with admin.settings.write (the Founder) and to nobody else', async () => {
    tax.listTaxCodes.mockResolvedValue([]);
    expect((await loadLookups({ roles: ['founder'] } as Session, 'customer')).canAddTerms).toBe(
      true,
    );
    expect((await loadLookups(session, 'customer')).canAddTerms).toBe(false);
    expect((await loadLookups({ roles: [] } as unknown as Session, 'customer')).canAddTerms).toBe(
      false,
    );
  });
});
