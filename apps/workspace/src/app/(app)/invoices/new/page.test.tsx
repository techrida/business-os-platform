import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { CUSTOMER_LIST_MAX_LIMIT } from '@bos/contracts';
import { ApiError } from '@/lib/api';

import NewInvoicePage from './page';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ listCustomers: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'test-token', roles: ['accountant'] }),
}));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: () => Promise.resolve([]) }));
vi.mock('./actions', () => ({ createManualInvoiceAction: vi.fn() }));
vi.mock('./manual-invoice-form', () => ({
  ManualInvoiceForm: ({ customers }: { customers: readonly { label: string }[] }) => (
    <form aria-label="Manual invoice">
      {customers.map((customer) => customer.label).join(', ')}
    </form>
  ),
}));

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
    return Promise.resolve({
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
    });
  });

  const html = renderToStaticMarkup(await NewInvoicePage());
  expect(html).toContain('aria-label="Manual invoice"');
  expect(html).toContain('Invoice customer');
  expect(html).not.toContain('The customers did not load');
});
