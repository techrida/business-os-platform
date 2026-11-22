import type { CustomerDto } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CustomerDetail } from '@/components/p2/customers/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
const staff = vi.hoisted(() => ({
  session: { accessToken: 't', orgKind: 'staff', roles: ['sales'] } as Session,
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve(staff.session) }));
const api = vi.hoisted(() => ({ call: vi.fn(), getCustomer: vi.fn() }));
vi.mock('@/lib/api-procurement', () => ({ call: api.call }));
// The page reads the customer with its per-record `can` flags (getCustomerDetail) and keeps the real customerCan.
vi.mock('@/components/p2/customers/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/p2/customers/api')>()),
  getCustomerDetail: api.getCustomer,
}));
vi.mock('@/components/p2/customers/actions', () => ({ updateCustomerAction: vi.fn() }));
// The page gates on the live grants (GET /v1/me); sales holds customer.write.
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(new Map([['customer.write', 'all']])),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));

const { default: EditCustomerPage } = await import('./page');

const ID = '11111111-1111-4111-8111-111111111111';
const customer = (defaultCurrency: CustomerDto['defaultCurrency']): CustomerDetail => ({
  id: ID,
  number: 'CUS-0001',
  legalName: 'Himalayan Construction Pvt. Ltd.',
  panVatNo: '301234567',
  industry: 'Construction',
  relationship: 'active',
  ownerUserId: null,
  defaultCurrency,
  country: 'NP',
  address: { line: 'Balaju', city: 'Kathmandu' },
  mergedIntoId: null,
  version: 2,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
  can: {
    write: true,
    readVerification: false,
    openVerification: false,
    creditLimit: false,
    owner: false,
    paymentTerms: true,
  },
});

const render = async () =>
  renderToStaticMarkup(
    (await EditCustomerPage({ params: Promise.resolve({ id: ID }) })) as ReactElement,
  );

const currencyOptions = (html: string): string[] =>
  [...html.matchAll(/<option[^>]*value="(NPR|INR|USD)"/g)].map((m) => m[1] ?? '');

describe('the edit organization page', () => {
  // Fails on the old page, which offered every currency whatever Settings said.
  it("offers the enabled currencies plus the organization's own switched-off one", async () => {
    api.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'INR'] });
    api.getCustomer.mockResolvedValue(customer('USD'));
    const html = await render();

    expect(api.call.mock.calls.map((c) => c[1] as string)).toContain('/v1/settings/display');
    expect(currencyOptions(html)).toEqual(['NPR', 'INR', 'USD']);
    expect(html).toMatch(/<option[^>]*value="USD"[^>]*selected/);
    expect(html).toContain('USD (US dollar) is switched off in Settings.');
  });

  it('offers only the enabled currencies when the saved one is still enabled', async () => {
    api.call.mockResolvedValue({ enabledCurrencies: ['NPR'] });
    api.getCustomer.mockResolvedValue(customer('NPR'));
    const html = await render();

    expect(currencyOptions(html)).toEqual(['NPR']);
    expect(html).not.toContain('switched off in Settings');
  });

  // FX9: the form starts from the saved address line, city and the party's country (here a foreign one).
  it("fills the form with the organization's saved address, city and country", async () => {
    api.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });
    api.getCustomer.mockResolvedValue({
      ...customer('USD'),
      panVatNo: null,
      country: 'US',
      address: { line: '500 Howard Street', city: 'San Francisco' },
    });
    const html = await render();

    expect(html).toContain('500 Howard Street');
    expect(html).toContain('San Francisco');
    expect(html).toContain('value="US"');
  });
});
