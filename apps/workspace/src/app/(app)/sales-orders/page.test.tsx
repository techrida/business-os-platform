import { DEFAULT_ROLE_PERMISSIONS, type RoleKey } from '@bos/contracts';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { IDS, listItem } from './_lib/fixtures';
import SalesOrdersPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

// Include the dialog portal in the static render to verify its form fields and action footer.
vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const radix = await importOriginal<typeof import('@radix-ui/react-dialog')>();
  return {
    ...radix,
    Root: (props: ComponentProps<typeof radix.Root>) => <radix.Root {...props} open />,
    Portal: ({ children }: ComponentProps<typeof radix.Portal>) => children,
  };
});

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listSalesOrdersPage: vi.fn(),
  getSalesOrdersSummary: vi.fn(),
  listQuotations: vi.fn(),
  listCustomers: vi.fn(),
  getGrants: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  listSalesOrdersPage: mocks.listSalesOrdersPage,
  getSalesOrdersSummary: mocks.getSalesOrdersSummary,
}));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/lib/grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/grants')>()),
  getGrants: mocks.getGrants,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/sales-orders',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

const QUOTATION = {
  id: IDS.quotation,
  number: 'QT-2082-0042',
  currentVersionId: IDS.version,
  customerName: 'Himal Traders Pvt. Ltd.',
  currency: 'NPR',
  total: '5701358.50',
};

const SUMMARY = { total: 9, byStatus: { draft: 2, confirmed: 4, completed: 3, cancelled: 0 } };
const page = (items = [listItem()], total = items.length) => ({ items, total });

async function render(search: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await SalesOrdersPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  // The live grants of the session's role, as GET /v1/me would answer them for an unedited role.
  mocks.getGrants.mockImplementation((session: { roles: RoleKey[] }) => {
    const role = session.roles[0];
    return Promise.resolve(
      new Map(role === undefined ? [] : Object.entries(DEFAULT_ROLE_PERMISSIONS[role])),
    );
  });
  mocks.listSalesOrdersPage.mockResolvedValue(page());
  mocks.getSalesOrdersSummary.mockResolvedValue(SUMMARY);
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
    mocks.listSalesOrdersPage.mockResolvedValue(
      page([listItem({ number: null, status: 'draft', confirmedAt: null })]),
    );
    const html = await render();
    expect(html).toContain('Draft order');
    expect(html).toContain('Not confirmed yet');
  });

  it('sends repeated statuses and customers, the search and the page window to the API', async () => {
    await render({
      status: ['confirmed', 'draft', 'bogus'],
      customerId: [IDS.customer, 'nope'],
      q: ' himal ',
      page: '2',
      rows: '10',
    });
    expect(mocks.listSalesOrdersPage.mock.calls[0]?.[1]).toEqual({
      status: ['confirmed', 'draft'],
      customerId: [IDS.customer],
      q: 'himal',
      limit: 10,
      offset: 10,
    });
    mocks.listSalesOrdersPage.mockClear();
    await render({ status: 'toString', customerId: 'nope', q: 'h' });
    expect(mocks.listSalesOrdersPage.mock.calls[0]?.[1]).toEqual({
      status: [],
      customerId: [],
      limit: 25,
      offset: 0,
    });
  });

  it('counts the cards on the server and never passes the status to the summary', async () => {
    const html = await render({ status: 'draft', customerId: IDS.customer, q: 'himal' });
    expect(mocks.getSalesOrdersSummary.mock.calls[0]?.[1]).toEqual({
      customerId: [IDS.customer],
      q: 'himal',
    });
    expect(html).toContain('Matching orders');
    expect(html).toMatch(/Confirmed[\s\S]*?>4</);
    expect(html).toMatch(/Completed[\s\S]*?>3</);
  });

  it('keeps the list when the summary fails, without the status cards', async () => {
    mocks.getSalesOrdersSummary.mockRejectedValue(new ApiError(500, 'x'));
    const html = await render();
    expect(html).toContain('SO-2083/84-00001');
    expect(html).toContain('Total orders');
    const cards = /<section aria-label="Sales order summary"[\s\S]*?<\/section>/.exec(html)?.[0];
    expect(cards).toBeDefined();
    expect(cards).not.toContain('Confirmed');
  });

  it('shows the count of all matches and a pager over the server total', async () => {
    mocks.listSalesOrdersPage.mockResolvedValue(page([listItem()], 31));
    const html = await render({ page: '2', rows: '10', status: 'confirmed' });
    expect(html).toContain('Showing 1 of 31 sales orders');
    expect(html).toContain('Page 2 of 4');
    expect(html).toContain('href="/sales-orders?rows=10&amp;status=confirmed"');
    expect(html).toContain('href="/sales-orders?page=3&amp;rows=10&amp;status=confirmed"');
  });

  it('lands a page past the end on the last page', async () => {
    mocks.listSalesOrdersPage
      .mockResolvedValueOnce(page([], 31))
      .mockResolvedValueOnce(page([listItem()], 31));
    const html = await render({ page: '9', rows: '10' });
    expect(mocks.listSalesOrdersPage.mock.calls[1]?.[1]).toMatchObject({ limit: 10, offset: 30 });
    expect(html).toContain('Page 4 of 4');
  });

  it('is a GET form with instant filters and no Apply button', async () => {
    const html = await render({ status: 'completed', customerId: IDS.customer });
    expect(html).toContain('method="get"');
    expect(html).toContain('name="status" value="completed"');
    expect(html).toContain(`name="customerId" value="${IDS.customer}"`);
    expect(html).not.toContain('Apply');
  });

  it('leaves the customer filter out when the customers cannot be read', async () => {
    mocks.listCustomers.mockRejectedValue(new ApiError(403, 'x', { error: { code: 'forbidden' } }));
    const html = await render();
    expect(html).not.toContain('All customers');
    expect(html).toContain('All statuses');
  });

  it('says what an empty list means, naming the filters and offering to clear them', async () => {
    mocks.listSalesOrdersPage.mockResolvedValue(page([], 0));
    expect(await render()).toContain('No sales orders yet.');
    const filtered = await render({
      status: ['cancelled', 'draft'],
      customerId: IDS.customer,
      q: 'zzz',
      rows: '10',
    });
    expect(filtered).toContain('No matching sales orders.');
    expect(filtered).toContain('Status: Cancelled, Draft');
    expect(filtered).toContain('Customer: Himal Traders Pvt. Ltd.');
    expect(filtered).toContain('Search');
    expect(filtered).toContain('Clear filters');
    expect(filtered).toContain('href="/sales-orders?rows=10"');
  });

  it('shows the no-access pattern on 403, without a retry link', async () => {
    mocks.listSalesOrdersPage.mockRejectedValue(
      new ApiError(403, 'x', { error: { code: 'forbidden', message: 'm', correlationId: 'c' } }),
    );
    const html = await render();
    expect(html).toContain('Your roles do not include sales orders');
    expect(html).not.toContain('Reload the sales orders');
  });

  it('shows a reloadable error when the list fails', async () => {
    mocks.listSalesOrdersPage.mockRejectedValue(new ApiError(500, 'x'));
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

// The Confirm button follows the live grants from GET /v1/me, not the role's defaults.
describe('confirm gate on live grants', () => {
  it('offers Confirm to a role given sales_order.confirm, and hides it from a role that lost it', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getGrants.mockResolvedValueOnce(new Map([['sales_order.confirm', 'all']]));
    expect(await render()).toContain('Confirm from quotation');

    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getGrants.mockResolvedValueOnce(new Map([['sales_order.read', 'all']]));
    expect(await render()).not.toContain('Confirm from quotation');
  });
});
