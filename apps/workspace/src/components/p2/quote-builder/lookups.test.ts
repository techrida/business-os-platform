import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

import { loadLookups } from './lookups';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => ({ listContacts: vi.fn(), listPaymentTerms: vi.fn() }));
const tax = vi.hoisted(() => ({ listTaxCodes: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('@/lib/api-tax-codes', () => tax);

const session = { roles: ['sales'] } as Session;
const code = { id: '11111111-1111-4111-8111-111111111111', label: 'VAT 13%', rate: '13' };

beforeEach(() => {
  vi.clearAllMocks();
  api.listPaymentTerms.mockResolvedValue([]);
  api.listContacts.mockResolvedValue([]);
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
    });
    tax.listTaxCodes.mockResolvedValue([]);
    expect((await loadLookups(session, 'customer')).taxCodes).toEqual([]);
  });
});
