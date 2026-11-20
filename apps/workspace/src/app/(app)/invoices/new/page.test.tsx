import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { CUSTOMER_LIST_MAX_LIMIT } from '@bos/contracts';
import { ApiError } from '@/lib/api';

import NewInvoicePage from './page';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ listCustomers: vi.fn(), call: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'test-token', roles: ['accountant'] }),
}));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: () => Promise.resolve([]) }));
// The real `loadEnabledCurrencies` reads `GET /v1/settings/display` through this client.
vi.mock('@/lib/api-procurement', () => ({ call: mocks.call }));
vi.mock('./actions', () => ({ createManualInvoiceAction: vi.fn() }));
// GET /v1/me for an unedited role answers the role's default grants.
vi.mock('@/lib/live-permissions', async () => {
  const { permissionChecker } = await import('@/components/p2/customers/permissions');
  return {
    getPermissionCheck: (s: { roles: string[] }) => Promise.resolve(permissionChecker(s.roles)),
  };
});

const customerPage = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      legalName: 'Invoice customer',
      number: 'CUS-001',
      defaultCurrency: 'NPR',
      mergedIntoId: null,
    },
  ],
  total: 1,
};

beforeEach(() => {
  mocks.listCustomers.mockReset().mockResolvedValue(customerPage);
  mocks.call
    .mockReset()
    .mockImplementation((_session, path: string) =>
      path === '/v1/settings/display'
        ? Promise.resolve({ enabledCurrencies: ['NPR', 'INR', 'USD'] })
        : Promise.reject(new ApiError(404, 'Not found')),
    );
});

/** The currency Select's choices: the options of the hidden native select after its named input. */
const currencyOptions = (html: string): string[] => {
  const after = html.slice(html.lastIndexOf('name="currency"'));
  const select = /<select[^>]*>(.*?)<\/select>/s.exec(after)?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1] ?? '');
};

it('loads the manual invoice picker using a query accepted by the real customer API', async () => {
  mocks.listCustomers.mockImplementation((_session, query: { limit: number }) => {
    // Hold the page's actual request to the API's shared page-size limit (the API schema and
    // its tests use the same contract constant). A permissive list mock previously hid the
    // rejected 200-customer request. The workspace must not import API source: the workspace
    // image installs only its own dependencies and type-checks this file during `next build`.
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > CUSTOMER_LIST_MAX_LIMIT
    ) {
      return Promise.reject(new ApiError(400, 'Invalid customer page size'));
    }
    return Promise.resolve(customerPage);
  });

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toContain('Save draft invoice');
  expect(html).toContain('Invoice customer (CUS-001)');
  expect(html).not.toContain('The customers did not load');
});

it('offers only the currencies the company has switched on', async () => {
  mocks.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(currencyOptions(html)).toEqual(['NPR', 'USD']);
  expect(html).not.toContain('INR (Indian rupee)');
});

it('offers the default list when the display settings cannot be read', async () => {
  mocks.call.mockRejectedValue(new ApiError(503, 'Unavailable'));

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(currencyOptions(html)).toEqual(['NPR', 'INR', 'USD']);
  expect(html).toContain('Save draft invoice');
});

it('draws the Figma card eyebrows as decoration and one column header row for the lines', async () => {
  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toMatch(
    /<span[^>]*aria-hidden="true"[^>]*>01 · The basics<\/span>Customer and source/,
  );
  expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>02 · The story<\/span>Line Items/);
  // The header row is hidden from assistive technology; each input keeps its own label.
  expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*><span>#<\/span>/);
  // Once in the header row, once as line 1's own label.
  expect(html.match(/Unit price \(NPR\)/g)).toHaveLength(2);
});

it('offers an optional document discount, none by default', async () => {
  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toContain('name="discountMode"');
  expect(html).toContain('No discount');
  expect(html).toContain('Fixed amount');
  // No value field until a discount type is chosen.
  expect(html).not.toContain('name="discountValue"');
});
