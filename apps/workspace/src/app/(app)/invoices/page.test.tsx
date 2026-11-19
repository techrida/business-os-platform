import type { InvoiceListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import InvoicesPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listInvoicesPage: vi.fn(),
  getInvoicesSummary: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', () => ({
  listInvoicesPage: mocks.listInvoicesPage,
  getInvoicesSummary: mocks.getInvoicesSummary,
}));
// The filter toolbar is a client component that reads the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/invoices',
  useSearchParams: () => new URLSearchParams(),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';

function item(over: Partial<InvoiceListItem> = {}): InvoiceListItem {
  return {
    id: ID,
    kind: 'tax_invoice',
    status: 'issued',
    number: 'INV-2083/84-00001',
    customerId: CUSTOMER,
    customerName: 'Himalayan Agro Foods',
    currency: 'NPR',
    total: '2018180.00',
    issueDate: '2026-11-08',
    dueDate: '2026-12-08',
    ...over,
  };
}

async function render(search: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await InvoicesPage({ searchParams: Promise.resolve(search) }));
}

const OTHER = '44444444-4444-4444-8444-444444444444';
const SUMMARY = {
  total: 7,
  byStatus: { draft: 2, submitted: 1, returned: 0, approved: 0, issued: 4, discarded: 0 },
  customers: [
    { id: CUSTOMER, name: 'Himalayan Agro Foods' },
    { id: OTHER, name: 'Everest Traders' },
  ],
};
const page = (items: InvoiceListItem[], total = items.length) => ({ items, total });

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.listInvoicesPage.mockReset().mockResolvedValue(page([item()]));
  mocks.getInvoicesSummary.mockReset().mockResolvedValue(SUMMARY);
});

describe('invoice list', () => {
  it('shows number, kind, customer, status and the total in lakh grouping', async () => {
    const html = await render();
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('Tax invoice');
    expect(html).toContain('Himalayan Agro Foods');
    expect(html).toContain('Issued');
    expect(html).toContain('20,18,180');
    expect(html).toContain(`href="/invoices/${ID}"`);
  });

  it('names an unnumbered draft by its kind and never prints "null"', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page([item({ number: null, status: 'draft', issueDate: null, kind: 'proforma' })]),
    );
    const html = await render();
    expect(html).toContain('Proforma');
    expect(html).toContain('Draft');
    expect(html).not.toContain('null');
  });

  it('offers Create Invoice to the people who may draft one, and to nobody else', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    expect(await render()).toMatch(/<a[^>]*href="\/invoices\/new"[^>]*>.*Create Invoice<\/a>/);
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    expect(await render()).not.toContain('Create Invoice');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    expect(await render()).not.toContain('Create Invoice');
  });

  it('reads a repeated param as several values, not as no filter', async () => {
    await render({
      status: ['issued', 'draft'],
      kind: 'credit_note',
      settlement: ['overdue', 'paid'],
      customerId: [CUSTOMER, OTHER],
      issuedFrom: '2026-11-01',
      issuedTo: '2026-11-30',
      q: ' acme ',
    });
    expect(mocks.listInvoicesPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['issued', 'draft'],
      kind: ['credit_note'],
      settlement: ['overdue', 'paid'],
      customerId: [CUSTOMER, OTHER],
      issuedFrom: '2026-11-01',
      issuedTo: '2026-11-30',
      q: 'acme',
      limit: 25,
      offset: 0,
    });
  });

  it('keeps chosen values selected in the form, so a no-JavaScript submit repeats them', async () => {
    const html = await render({ status: ['approved', 'issued'], issuedFrom: '2026-11-01' });
    expect(html).toContain('<input type="hidden" name="status" value="approved"');
    expect(html).toContain('<input type="hidden" name="status" value="issued"');
    expect(html).toContain('value="2026-11-01"');
    expect(html).not.toContain('Apply');
  });

  it.each([
    { kind: 'Credit_Note' },
    { status: 'paid' },
    { status: ['x', 'y'] },
    { customerId: 'not-an-id' },
    { issuedFrom: 'yesterday' },
    { rows: '7' },
    { page: 'abc' },
  ])('drops a bad value %j and asks for the unfiltered first page', async (search) => {
    await render(search);
    expect(mocks.listInvoicesPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      kind: [],
      settlement: [],
      customerId: [],
      issuedFrom: undefined,
      issuedTo: undefined,
      q: undefined,
      limit: 25,
      offset: 0,
    });
  });

  it('asks the server for the page and the counts, once each, and never fetches every invoice', async () => {
    await render({ status: 'issued' });
    expect(mocks.listInvoicesPage).toHaveBeenCalledTimes(1);
    expect(mocks.getInvoicesSummary).toHaveBeenCalledTimes(1);
    expect(mocks.getInvoicesSummary.mock.calls[0]?.[1]).not.toHaveProperty('limit');
  });

  it('shows the server counts on the stat cards and the customer choices from the summary', async () => {
    const html = await render();
    expect(html).toContain('Total invoices');
    expect(html).toMatch(/Issued<\/[^>]+>\s*<[^>]+>4</);
    expect(html).toContain('Everest Traders');
  });

  it('pages by the server total, keeps the filters in the links and the rows choice', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page(
        Array.from({ length: 10 }, (_, i) =>
          item({ id: `${i}1111111-1111-4111-8111-111111111111` }),
        ),
        60,
      ),
    );
    const html = await render({ customerId: CUSTOMER, q: 'inv-2083', page: '3' });
    expect(mocks.listInvoicesPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25, offset: 50, customerId: [CUSTOMER], q: 'inv-2083' }),
    );
    expect(html).toContain('Showing 51–60 of 60');
    expect(html).toContain(`href="/invoices?customerId=${CUSTOMER}&amp;q=inv-2083&amp;page=2"`);
    // Another rows value drops the page and keeps the filters.
    expect(html).toContain(`href="/invoices?customerId=${CUSTOMER}&amp;q=inv-2083&amp;rows=50"`);
  });

  it('shows the last page when the asked-for page is past the end', async () => {
    mocks.listInvoicesPage
      .mockResolvedValueOnce(page([], 30))
      .mockResolvedValueOnce(page([item()], 30));
    const html = await render({ page: '9' });
    expect(mocks.listInvoicesPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25, offset: 25 }),
    );
    expect(html).toContain('INV-2083/84-00001');
  });

  it('names the filters that hide everything, with a way to clear them', async () => {
    mocks.listInvoicesPage.mockResolvedValue(page([], 0));
    const html = await render({
      status: ['issued', 'draft'],
      customerId: OTHER,
      q: 'zzz',
      rows: '50',
    });
    expect(html).toContain('No invoices match these filters');
    expect(html).toContain('Status: Issued, Draft');
    expect(html).toContain('Customer: Everest Traders');
    expect(html).toContain('Search “zzz”');
    expect(html).toContain('href="/invoices?rows=50"');
    expect(html).toContain('Clear filters');
    expect(await render()).toContain('No invoices yet');
  });

  it('still shows the table when only the counts fail', async () => {
    mocks.getInvoicesSummary.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('INV-2083/84-00001');
    expect(html).not.toContain('Invoice summary');
  });

  it('shows the no-access notice for a 403 and no table', async () => {
    mocks.listInvoicesPage.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include invoices');
    expect(html).not.toContain('<table');
  });

  it('shows the error and a reload link that keeps the filters for a 500', async () => {
    mocks.listInvoicesPage.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render({ kind: ['proforma', 'credit_note'] });
    expect(html).toContain('The invoices did not load');
    expect(html).toContain('href="/invoices?kind=proforma&amp;kind=credit_note"');
  });

  it('keeps a very long customer name in the table cell, which wraps', async () => {
    const name = 'Long '.repeat(60).trim();
    mocks.listInvoicesPage.mockResolvedValue(page([item({ customerName: name })]));
    expect(await render()).toContain(name);
  });
});
