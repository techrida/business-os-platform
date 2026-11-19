import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const staff = vi.hoisted(() => ({
  session: { accessToken: 't', orgKind: 'staff', roles: ['sales'] } as Session,
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve(staff.session) }));
const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/api-procurement', () => ({ call: api.call }));
vi.mock('@/components/p2/customers/actions', () => ({ createCustomerAction: vi.fn() }));
// The page gates on the live grants (GET /v1/me); sales holds customer.write.
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(new Map([['customer.write', 'all']])),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));

const { default: NewCustomerPage } = await import('./page');

const currencyOptions = (html: string): string[] =>
  [...html.matchAll(/<option[^>]*value="(NPR|INR|USD)"/g)].map((m) => m[1] ?? '');

describe('the create organization page', () => {
  // Fails on the old page, which never read the enabled currencies and offered all three.
  it('offers only the currencies enabled in Settings as the default currency', async () => {
    api.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });
    const html = renderToStaticMarkup((await NewCustomerPage()) as ReactElement);

    expect(api.call.mock.calls.map((c) => c[1] as string)).toContain('/v1/settings/display');
    expect(currencyOptions(html)).toEqual(['NPR', 'USD']);
  });

  it('falls back to the default list when the display read fails', async () => {
    api.call.mockRejectedValue(new Error('down'));
    const html = renderToStaticMarkup((await NewCustomerPage()) as ReactElement);

    expect(currencyOptions(html)).toEqual(['NPR', 'INR', 'USD']);
  });
});
