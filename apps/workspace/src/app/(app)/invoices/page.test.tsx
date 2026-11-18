import type { InvoiceListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import InvoicesPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ requireStaffSession: vi.fn(), listInvoices: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', () => ({ listInvoices: mocks.listInvoices }));

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

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.listInvoices.mockReset().mockResolvedValue([item()]);
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
    mocks.listInvoices.mockResolvedValue([
      item({ number: null, status: 'draft', issueDate: null, kind: 'proforma' }),
    ]);
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

  it('passes only a valid kind and status to the API', async () => {
    await render({ kind: 'credit_note', status: 'issued' });
    expect(mocks.listInvoices).toHaveBeenCalledWith(expect.anything(), {
      kind: 'credit_note',
      status: 'issued',
    });
  });

  it.each([
    { kind: 'Credit_Note' },
    { status: 'paid' },
    { status: ['issued', 'draft'] },
    { kind: 'x' },
  ])('ignores a bad filter %j and asks for everything', async (search) => {
    await render(search);
    expect(mocks.listInvoices).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('keeps the chosen filter selected in the form and offers a way back', async () => {
    const html = await render({ status: 'approved' });
    expect(html).toMatch(/<option value="approved"[^>]*selected/);
    expect(html).toContain('Show all invoices');
  });

  it('says what an empty filtered list means, and what an empty list means', async () => {
    mocks.listInvoices.mockResolvedValue([]);
    expect(await render({ status: 'issued' })).toContain('No invoices match these filters');
    expect(await render()).toContain('No invoices yet');
  });

  it('shows the no-access notice for a 403 and no table', async () => {
    mocks.listInvoices.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include invoices');
    expect(html).not.toContain('<table');
  });

  it('shows the error and a reload link that keeps the filters for a 500', async () => {
    mocks.listInvoices.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render({ kind: 'proforma' });
    expect(html).toContain('The invoices did not load');
    expect(html).toContain('href="/invoices?kind=proforma"');
  });

  it('preserves the customer and search while paging the authorized result', async () => {
    const scoped = Array.from({ length: 6 }, (_, index) =>
      item({
        id: `${index}1111111-1111-4111-8111-111111111111`,
        number: `INV-2083/84-0000${index + 1}`,
      }),
    );
    mocks.listInvoices
      .mockResolvedValueOnce([...scoped, item({ number: 'INV-2082/83-OTHER' })])
      .mockResolvedValueOnce(scoped);
    const html = await render({ customerId: CUSTOMER, q: 'inv-2083/84', page: '2' });
    expect(mocks.listInvoices).toHaveBeenNthCalledWith(1, expect.anything(), {
      customerId: CUSTOMER,
    });
    expect(html).toContain('Showing 6–6 of 6');
    expect(html).toContain('INV-2083/84-00006');
    expect(html).not.toContain('INV-2083/84-00001');
    expect(html).not.toContain('INV-2082/83-OTHER');
    expect(html).toContain(`href="/invoices?customerId=${CUSTOMER}&amp;q=inv-2083%2F84"`);
  });

  it('keeps a very long customer name in the table cell, which wraps', async () => {
    const name = 'Long '.repeat(60).trim();
    mocks.listInvoices.mockResolvedValue([item({ customerName: name })]);
    expect(await render()).toContain(name);
  });
});
