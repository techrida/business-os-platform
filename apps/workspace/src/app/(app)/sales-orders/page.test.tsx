import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { IDS, listItem } from './_lib/fixtures';
import SalesOrdersPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listSalesOrders: vi.fn(),
  listQuotations: vi.fn(),
  listCustomers: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  listSalesOrders: mocks.listSalesOrders,
}));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));

const QUOTATION = {
  id: IDS.quotation,
  number: 'QT-2082-0042',
  currentVersionId: IDS.version,
  customerName: 'Himal Traders Pvt. Ltd.',
  currency: 'NPR',
  total: '5701358.50',
};

async function render(
  search: { status?: string | string[]; customerId?: string | string[] } = {},
): Promise<string> {
  return renderToStaticMarkup(await SalesOrdersPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.listSalesOrders.mockResolvedValue([listItem()]);
  mocks.listQuotations.mockResolvedValue([QUOTATION]);
  mocks.listCustomers.mockResolvedValue({
    items: [{ id: IDS.customer, legalName: 'Himal Traders Pvt. Ltd.' }],
    total: null,
  });
});

describe('sales orders list', () => {
  it('shows each order with its number, customer, status and total in lakh grouping', async () => {
    const html = await render();
    expect(html).toContain('SO-2083/84-00001');
    expect(html).toContain(`/sales-orders/${IDS.order}`);
    expect(html).toContain('Himal Traders Pvt. Ltd.');
    expect(html).toContain('Confirmed');
    expect(html).toContain('57,01,358.50');
    expect(html).toContain('1 sales order');
  });

  it('names an order that has no number yet instead of leaving a blank link', async () => {
    mocks.listSalesOrders.mockResolvedValue([
      listItem({ number: null, status: 'draft', confirmedAt: null }),
    ]);
    const html = await render();
    expect(html).toContain('Draft order');
    expect(html).toContain('Not confirmed yet');
  });

  it('filters by a contract status and a customer, and ignores anything else in the URL', async () => {
    await render({ status: 'confirmed', customerId: IDS.customer });
    expect(mocks.listSalesOrders.mock.calls[0]?.[1]).toEqual({
      status: 'confirmed',
      customerId: IDS.customer,
    });
    await render({ status: 'toString', customerId: 'nope' });
    expect(mocks.listSalesOrders.mock.calls[1]?.[1]).toEqual({});
  });

  it('keeps the filter in the form, as a GET form with labelled controls', async () => {
    const html = await render({ status: 'completed', customerId: IDS.customer });
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/sales-orders"');
    expect(html).toContain('<label');
    expect(html).toMatch(/<option value="completed" selected/);
    expect(html).toMatch(new RegExp(`<option value="${IDS.customer}" selected`));
    expect(html).toContain('Show all sales orders');
  });

  it('leaves the customer filter out when the customers cannot be read', async () => {
    mocks.listCustomers.mockRejectedValue(new ApiError(403, 'x', { error: { code: 'forbidden' } }));
    const html = await render();
    expect(html).not.toContain('name="customerId"');
    expect(html).toContain('name="status"');
  });

  it('says what an empty list means, with and without a filter', async () => {
    mocks.listSalesOrders.mockResolvedValue([]);
    expect(await render()).toContain('No sales orders yet.');
    const filtered = await render({ status: 'cancelled' });
    expect(filtered).toContain('No sales orders are cancelled.');
    expect(filtered).toContain('Show all sales orders');
  });

  it('shows the no-access pattern on 403, without a retry link', async () => {
    mocks.listSalesOrders.mockRejectedValue(
      new ApiError(403, 'x', { error: { code: 'forbidden', message: 'm', correlationId: 'c' } }),
    );
    const html = await render();
    expect(html).toContain('Your roles do not include sales orders');
    expect(html).not.toContain('Reload the sales orders');
  });

  it('shows a reloadable error when the list fails', async () => {
    mocks.listSalesOrders.mockRejectedValue(new ApiError(500, 'x'));
    const html = await render({ status: 'confirmed' });
    expect(html).toContain('The sales orders did not load');
    expect(html).toContain('href="/sales-orders?status=confirmed"');
  });

  it('offers Confirm from quotation only to a role that may confirm', async () => {
    expect(await render()).toContain('Confirm from quotation');
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), { status: 'accepted' });

    mocks.listQuotations.mockClear();
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    const html = await render();
    expect(html).not.toContain('Confirm from quotation');
    expect(mocks.listQuotations).not.toHaveBeenCalled();
    expect(html).toContain('SO-2083/84-00001');
  });

  it('puts the accepted quotations in the confirm dialog and sends the current version id', async () => {
    const html = await render();
    expect(html).toContain(`<option value="${IDS.version}"`);
    expect(html).toContain('QT-2082-0042');
    expect(html).toContain('name="evidenceDocumentIds"');
    expect(html).toContain('name="idempotencyKey"');
  });

  it('says so in the dialog when there is nothing to confirm, or the quotations did not load', async () => {
    mocks.listQuotations.mockResolvedValue([]);
    expect(await render()).toContain('No accepted quotations are waiting');
    mocks.listQuotations.mockRejectedValue(new ApiError(500, 'x'));
    const html = await render();
    expect(html).toContain('The accepted quotations did not load');
    expect(html).not.toContain('name="quotationVersionId"');
  });
});
