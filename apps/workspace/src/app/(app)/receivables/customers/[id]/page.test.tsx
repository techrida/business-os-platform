import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { advanceRow, CUSTOMER_ID, INVOICE_ID, settlementRow } from '../../_lib/fixtures';
import CustomerStatementPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getCustomerStatement: vi.fn(),
  getCustomerAdvance: vi.fn(),
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-receivables', () => ({
  getCustomerStatement: mocks.getCustomerStatement,
  getCustomerAdvance: mocks.getCustomerAdvance,
}));
vi.mock('@/components/p2/customers/api', () => ({ getCustomer: mocks.getCustomer }));

async function render(id = CUSTOMER_ID): Promise<string> {
  return renderToStaticMarkup(await CustomerStatementPage({ params: Promise.resolve({ id }) }));
}

const OTHER_INVOICE = (n: number) => `66666666-6666-4666-8666-66666666666${n}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.getCustomer.mockResolvedValue({
    legalName: 'Himalayan Traders Pvt. Ltd.',
    mergedIntoId: null,
  });
  mocks.getCustomerStatement.mockResolvedValue([settlementRow()]);
  mocks.getCustomerAdvance.mockResolvedValue([advanceRow()]);
});

describe('customer statement', () => {
  it('asks the API for open items only, for the customer in the URL', async () => {
    await render();
    expect(mocks.getCustomerStatement).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID, {
      openOnly: true,
    });
    expect(mocks.getCustomerAdvance).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID);
  });

  it('shows the item with its number, due date, server amounts, a status in words and an invoice link', async () => {
    const html = await render();
    expect(html).toContain('INV-2083/84-00007');
    expect(html).toContain('NPR 5,00,000.00');
    expect(html).toContain('Overdue');
    expect(html).toContain('20 Oct 2026');
    expect(html).toContain('20 days overdue');
    expect(html).toContain(`href="/invoices/${INVOICE_ID}"`);
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).toContain('href="/payments"');
    expect(html).toContain('href="/receivables/aging"');
  });

  it('opens payment entry for this customer only for a role allowed to record payments', async () => {
    expect(await render()).toContain(`href="/payments/new?customerId=${CUSTOMER_ID}"`);
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    const readOnly = await render();
    expect(readOnly).toContain('href="/payments"');
    expect(readOnly).not.toContain('/payments/new');
  });

  it('counts open and overdue items and names the longest overdue, summing no money', async () => {
    mocks.getCustomerStatement.mockResolvedValue([
      settlementRow({ daysOverdue: 20 }),
      settlementRow({
        invoiceId: OTHER_INVOICE(7),
        number: 'INV-2083/84-00008',
        daysOverdue: 0,
        settlement: 'unpaid',
      }),
      settlementRow({ invoiceId: OTHER_INVOICE(8), number: 'INV-2083/84-00009', daysOverdue: 1 }),
    ]);
    const html = await render();
    const stats = /aria-label="Statement summary".*?<\/section>/s.exec(html)?.[0] ?? '';
    expect(stats).toMatch(/Open items<\/dt><dd[^>]*>3</);
    expect(stats).toMatch(/Overdue items<\/dt><dd[^>]*>2</);
    expect(stats).toMatch(/Longest overdue<\/dt><dd[^>]*>20 days</);
    // Three rows of NPR 1,23,456.78 would sum to 3,70,370.34; no money total is drawn.
    expect(stats).not.toContain('NPR');
    expect(html).not.toContain('3,70,370.34');
  });

  it('says no item is overdue, and draws no summary when nothing is open', async () => {
    mocks.getCustomerStatement.mockResolvedValue([settlementRow({ daysOverdue: 0 })]);
    expect(await render()).toMatch(/Longest overdue<\/dt><dd[^>]*>None</);
    mocks.getCustomerStatement.mockResolvedValue([]);
    expect(await render()).not.toContain('Statement summary');
  });

  it('shows the server open amount even when it is not total minus allocated', async () => {
    // 5,00,000.00 less 1,00,000.00 would be 4,00,000.00; the server says 1,23,456.78.
    const html = await render();
    expect(html).toContain('NPR 1,23,456.78');
    expect(html).not.toContain('4,00,000.00');
  });

  it('words every settlement status, and says so when an invoice has no due date', async () => {
    mocks.getCustomerStatement.mockResolvedValue([
      settlementRow({ settlement: 'unpaid', daysOverdue: 0, dueDate: null }),
      settlementRow({
        invoiceId: OTHER_INVOICE(7),
        number: 'INV-2',
        settlement: 'partly_paid',
        daysOverdue: 0,
      }),
      settlementRow({
        invoiceId: OTHER_INVOICE(8),
        number: 'INV-3',
        settlement: 'paid',
        openAmount: '0.00',
        daysOverdue: 0,
      }),
      settlementRow({
        invoiceId: OTHER_INVOICE(9),
        number: 'INV-4',
        settlement: 'credited',
        openAmount: '0.00',
        daysOverdue: 0,
      }),
    ]);
    const html = await render();
    for (const word of ['Unpaid', 'Partly paid', 'Paid', 'Credited', 'No due date']) {
      expect(html).toContain(word);
    }
    expect(html).not.toContain('days overdue');
  });

  it('shows the advance per currency as the server returned it', async () => {
    mocks.getCustomerAdvance.mockResolvedValue([
      advanceRow(),
      advanceRow({ currency: 'USD', amount: '1200.50' }),
    ]);
    const html = await render();
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('USD 1,200.50');
  });

  it('says there is no advance for a zero advance, read from the text', async () => {
    mocks.getCustomerAdvance.mockResolvedValue([advanceRow({ amount: '0.00' })]);
    const html = await render();
    expect(html).toContain('This customer has no advance.');
    expect(html).not.toContain('NPR 0.00');
  });

  it('has an empty state when there are no open items', async () => {
    mocks.getCustomerStatement.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain('Nothing is open for this customer.');
    expect(html).not.toContain('<table');
  });

  it('keeps the statement when the advance fails, saying so in words', async () => {
    mocks.getCustomerAdvance.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('INV-2083/84-00007');
    expect(html).toContain('The advance could not be loaded');
  });

  it('falls back to a short id when the customer name cannot be read', async () => {
    mocks.getCustomer.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Customer details unavailable');
    expect(html).toContain('INV-2083/84-00007');
  });

  it('says in words that the roles lack receivables on a 403 from the API', async () => {
    mocks.getCustomerStatement.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include receivables');
    expect(html).not.toContain('Reload this statement');
  });

  it('does not fetch anything for a role without ar.read', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    const html = await render();
    expect(html).toContain('Your roles do not include receivables');
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
    expect(mocks.getCustomerAdvance).not.toHaveBeenCalled();
    expect(mocks.getCustomer).not.toHaveBeenCalled();
  });

  it('shows not found for an unknown customer and offers a reload on an error', async () => {
    mocks.getCustomerStatement.mockRejectedValue(new ApiError(404, 'gone'));
    expect(await render()).toContain('Customer not found');
    mocks.getCustomerStatement.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('The statement did not load');
    expect(html).toContain('Reload this statement');
  });

  it('refuses an id that is not a customer id without calling the API', async () => {
    const html = await render('../../etc');
    expect(html).toContain('That is not a customer');
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
  });

  it('keeps a very long invoice number and customer name inside wrapping cells', async () => {
    mocks.getCustomer.mockResolvedValue({ legalName: 'C'.repeat(300) });
    mocks.getCustomerStatement.mockResolvedValue([settlementRow({ number: 'X'.repeat(40) })]);
    const html = await render();
    expect(html).toContain('C'.repeat(300));
    expect(html).toContain('X'.repeat(40));
    expect(html).toMatch(/class="[^"]*wrap/);
  });
});
