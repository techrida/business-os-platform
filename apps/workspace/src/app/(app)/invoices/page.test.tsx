import type { InvoiceListItem, MoneyTotals } from '@bos/contracts';
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
  getAging: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', () => ({
  listInvoicesPage: mocks.listInvoicesPage,
  getInvoicesSummary: mocks.getInvoicesSummary,
}));
vi.mock('@/lib/api-receivables', () => ({ getAging: mocks.getAging }));
// GET /v1/me for an unedited role answers the role's default grants.
vi.mock('@/lib/live-permissions', async () => {
  const { permissionChecker } = await import('@/components/p2/customers/permissions');
  return {
    getPermissionCheck: (s: { roles: string[] }) => Promise.resolve(permissionChecker(s.roles)),
  };
});
// The filter toolbar is a client component that reads the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/invoices',
  useSearchParams: () => new URLSearchParams(),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';

/**
 * A list row as the API sends it: an issued tax invoice or debit note carries its derived settlement and open
 * amount (unpaid and fully open unless the test says otherwise); every other row carries null for both.
 */
function item(over: Partial<InvoiceListItem> = {}): InvoiceListItem {
  const row = {
    id: ID,
    kind: 'tax_invoice' as const,
    status: 'issued' as const,
    number: 'INV-2083/84-00001',
    customerId: CUSTOMER,
    customerName: 'Himalayan Agro Foods',
    currency: 'NPR' as const,
    total: '2018180.00',
    issueDate: '2026-11-08',
    dueDate: '2026-12-08',
    ...over,
  };
  const owes = row.status === 'issued' && (row.kind === 'tax_invoice' || row.kind === 'debit_note');
  return {
    settlement: owes ? 'unpaid' : null,
    openAmount: owes ? row.total : null,
    ...row,
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
const page = (
  items: InvoiceListItem[],
  total = items.length,
  totals: MoneyTotals | null = null,
) => ({ items, total, totals });
const BUCKETS = {
  current: '0.00',
  d1_30: '0.00',
  d31_60: '0.00',
  d61_90: '0.00',
  d91_plus: '0.00',
};
const aging = (totals: { currency: 'NPR' | 'USD'; totalOpen: string }[]) => ({
  asOf: '2026-11-20',
  rows: [],
  totals: totals.map((t) => ({ ...t, buckets: BUCKETS })),
});

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.listInvoicesPage.mockReset().mockResolvedValue(page([item()]));
  mocks.getInvoicesSummary.mockReset().mockResolvedValue(SUMMARY);
  mocks.getAging
    .mockReset()
    .mockResolvedValue(aging([{ currency: 'NPR', totalOpen: '5295180.00' }]));
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
    mocks.getAging.mockRejectedValue(new ApiError(500, 'boom'));
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

describe('outstanding balance card', () => {
  it('shows the server-totalled open balance from the receivables aging, with the counts', async () => {
    const html = await render();
    expect(mocks.getAging).toHaveBeenCalledTimes(1);
    expect(html).toContain('Outstanding');
    expect(html).toContain('52,95,180');
    expect(html).toContain('Not yet paid, all customers');
    expect(html).toContain('Total invoices');
  });

  it('shows one card per currency and never adds currencies together', async () => {
    mocks.getAging.mockResolvedValue(
      aging([
        { currency: 'NPR', totalOpen: '1000.00' },
        { currency: 'USD', totalOpen: '250.50' },
      ]),
    );
    const html = await render();
    expect(html).toContain('Outstanding · NPR');
    expect(html).toContain('Outstanding · USD');
    expect(html).toContain('250.50');
    expect(html).not.toContain('1,250.50');
  });

  it('is left out, without asking, for a role that cannot read receivables', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    const html = await render();
    expect(mocks.getAging).not.toHaveBeenCalled();
    expect(html).not.toContain('Outstanding');
  });

  it('is left out when the aging fails or has nothing open; the rest of the page stands', async () => {
    mocks.getAging.mockRejectedValue(new ApiError(500, 'boom'));
    let html = await render();
    expect(html).not.toContain('Outstanding');
    expect(html).toContain('Total invoices');
    expect(html).toContain('INV-2083/84-00001');
    mocks.getAging.mockResolvedValue(aging([]));
    html = await render();
    expect(html).not.toContain('Outstanding');
  });

  it('still shows when only the counts fail', async () => {
    mocks.getInvoicesSummary.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('Outstanding');
    expect(html).not.toContain('Total invoices');
  });
});

describe('record payment row action', () => {
  // Each row's link names its own invoice (U16-Q8 a); the payment form reads the open amount itself.
  const RECORD = `href="/payments/new?customerId=${CUSTOMER}&amp;invoiceId=${ID}"`;

  it('offers Record payment on every row that still owes, with no Payment filter set', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.listInvoicesPage.mockResolvedValue(
      page([
        item(),
        item({ id: OTHER, number: 'INV-2083/84-00002', settlement: 'overdue' }),
        item({
          id: '55555555-5555-4555-8555-555555555555',
          number: 'INV-2083/84-00003',
          settlement: 'partly_paid',
          openAmount: '18180.00',
        }),
      ]),
    );
    const html = await render();
    expect(html).toContain(RECORD);
    expect(html).toContain(`href="/payments/new?customerId=${CUSTOMER}&amp;invoiceId=${OTHER}"`);
    // Old code offered it only when the Payment filter selected owing states.
    expect(html).toContain('Record payment for INV-2083/84-00001');
    expect(html).toContain('Record payment for INV-2083/84-00002');
    expect(html).toContain('Record payment for INV-2083/84-00003');
  });

  it('offers nothing on a paid or credited row, whatever the filter', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.listInvoicesPage.mockResolvedValue(
      page([
        item({ settlement: 'paid', openAmount: '0.00' }),
        item({
          id: OTHER,
          number: 'INV-2083/84-00002',
          settlement: 'credited',
          openAmount: '0.00',
        }),
      ]),
    );
    expect(await render()).not.toContain('Record payment');
    expect(await render({ settlement: ['unpaid'] })).not.toContain('Record payment');
  });

  it('hides it from a role without payment.record', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    const html = await render({ settlement: ['unpaid'] });
    expect(html).toContain('INV-2083/84-00001');
    expect(html).not.toContain('Record payment');
  });

  it('hides it on rows that open nothing to pay: drafts, proformas and credit notes', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page([
        item({ status: 'draft', number: null, issueDate: null }),
        item({ id: OTHER, kind: 'proforma' }),
        item({ id: '55555555-5555-4555-8555-555555555555', kind: 'credit_note' }),
      ]),
    );
    expect(await render({ settlement: ['unpaid'] })).not.toContain('Record payment');
  });

  it("follows each row's can: hidden where the grant does not reach, kept where can is missing", async () => {
    // Finance holds payment.record; only the API's per-row answer tells the rows apart.
    const can = { submit: false, issue: false, discard: false, notes: false };
    mocks.listInvoicesPage.mockResolvedValue(
      page([
        item({ can: { ...can, recordPayment: true } }),
        item({ id: OTHER, number: 'INV-2083/84-00002', can: { ...can, recordPayment: false } }),
        item({ id: '55555555-5555-4555-8555-555555555555', number: 'INV-2083/84-00003' }),
      ]),
    );
    const html = await render({ settlement: ['unpaid'] });
    expect(html).toContain('Record payment for INV-2083/84-00001');
    expect(html).toContain('INV-2083/84-00002');
    expect(html).not.toContain('Record payment for INV-2083/84-00002');
    expect(html).toContain('Record payment for INV-2083/84-00003');
  });
});

describe('total row', () => {
  it('ends the table with the totals of every match, one row per currency, under the Total column', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page([item()], 41, [
        { currency: 'NPR', amount: '2018180.00' },
        { currency: 'USD', amount: '25.00' },
      ]),
    );
    const foot = /<tfoot>.*<\/tfoot>/s.exec(await render())?.[0] ?? '';
    // Old code showed no total at all.
    expect(foot).toContain('Total, all pages · NPR');
    expect(foot).toContain('20,18,180.00');
    expect(foot).toContain('Total, all pages · USD');
    expect(foot).toContain('colSpan="5"');
    // The sum and the two columns after it are pinned like the Total, Status and Action cells above them.
    expect(foot.match(/data-pinned/g)).toHaveLength(6);
  });

  it('says plain Total when every match is on the page, and shows none without totals', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page([item()], 1, [{ currency: 'NPR', amount: '2018180.00' }]),
    );
    expect(await render()).toMatch(/<tfoot>.*>Total<.*<\/tfoot>/s);
    mocks.listInvoicesPage.mockResolvedValue(page([item()]));
    expect(await render()).not.toContain('<tfoot>');
  });
});

describe('Status column', () => {
  it('shows where an issued invoice’s payment stands, one word, and the approval status otherwise', async () => {
    mocks.listInvoicesPage.mockResolvedValue(
      page([
        item({ settlement: 'paid', openAmount: '0.00' }),
        item({ id: OTHER, number: 'INV-2083/84-00002', settlement: 'overdue' }),
        item({
          id: '55555555-5555-4555-8555-555555555555',
          number: 'INV-2083/84-00003',
          settlement: 'partly_paid',
          openAmount: '18180.00',
        }),
        item({
          id: '66666666-6666-4666-8666-666666666666',
          status: 'draft',
          number: null,
          issueDate: null,
        }),
      ]),
    );
    const html = await render();
    const statuses = [...html.matchAll(/<tr>.*?<\/tr>/gs)]
      .slice(1)
      .map(
        (row) =>
          /<td[^>]*><span class="[^"]*badge[^"]*"[^>]*>([^<]+)<\/span><\/td>(?![\s\S]*badge)/.exec(
            row[0],
          )?.[1],
      );
    // Old code showed "Issued" for all three issued rows.
    expect(statuses).toEqual(['Paid', 'Overdue', 'Partial', 'Draft']);
  });
});
