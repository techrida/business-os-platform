import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { APPROVAL, CUSTOMER, ID, invoiceDetail, SALES_ORDER, TAX } from '../_lib/test-fixtures';

import InvoiceDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getInvoice: vi.fn(),
  listTaxCodes: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  getInvoice: mocks.getInvoice,
}));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: mocks.listTaxCodes }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// A marked anchor, so a test can tell the PDF link (a plain anchor) from a prefetching Link.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-next-link="">
      {children}
    </a>
  ),
}));

async function render(id: string = ID): Promise<string> {
  return renderToStaticMarkup(await InvoiceDetailPage({ params: Promise.resolve({ id }) }));
}

const issued = (over: Record<string, unknown> = {}) =>
  invoiceDetail({ status: 'issued', approvalRequestId: APPROVAL, ...over });

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.getInvoice.mockReset().mockResolvedValue(issued());
  mocks.listTaxCodes.mockReset().mockResolvedValue([{ id: TAX, label: 'VAT 13%' }]);
  mocks.notFound.mockClear();
});

describe('invoice detail page', () => {
  it('shows number, issue date (AD and BS) and the buyer, all as read-only text', async () => {
    const html = await render();
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('2083-07-23');
    expect(html).toContain('Himalayan Agro Foods');
    expect(html).not.toMatch(/<input[^>]*(number|issueDate)/i);
  });

  it('names the customer of a draft, which has no buyer snapshot yet, from the name the API sends', async () => {
    // An accountant reads invoices; the page asks no customer route, so it needs no customer.read.
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getInvoice.mockResolvedValue(
      invoiceDetail({ status: 'draft', buyer: null }, { customerName: 'Himalayan Agro Foods' }),
    );
    const text = (await render()).replace(/<[^>]*>/g, ' ');
    expect(text).toContain('Himalayan Agro Foods');
    expect(text).not.toContain('Customer details unavailable');
  });

  it('keeps the name frozen at issue on an issued invoice, even after the customer is renamed', async () => {
    mocks.getInvoice.mockResolvedValue(
      invoiceDetail(
        {
          status: 'issued',
          approvalRequestId: APPROVAL,
          buyer: { legalName: 'Old Name Pvt. Ltd.', panVatNo: null, address: null },
        },
        { customerName: 'New Name Pvt. Ltd.' },
      ),
    );
    const text = (await render()).replace(/<[^>]*>/g, ' ');
    expect(text).toContain('Old Name Pvt. Ltd.');
    expect(text).not.toContain('New Name Pvt. Ltd.');
  });

  it('uses readable relationship labels without exposing database IDs', async () => {
    mocks.getInvoice.mockResolvedValue(
      invoiceDetail({
        kind: 'credit_note',
        buyer: null,
        originalInvoiceId: ID,
        noteReason: 'Correction',
      }),
    );
    const html = await render();
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toContain('Customer details unavailable');
    expect(text).toContain('Open sales order');
    expect(text).toContain('Open original invoice');
    for (const id of [CUSTOMER, SALES_ORDER, ID]) {
      expect(text).not.toContain(id.slice(-8));
    }
    expect(html).toContain(`/sales-orders/${SALES_ORDER}`);
    expect(html).toContain(`/invoices/${ID}`);
  });

  it('shows the totals by bucket, from the server, in lakh grouping', async () => {
    const html = await render();
    for (const label of [
      'Subtotal',
      'Discount',
      'Taxable amount',
      'Exempt',
      'Zero-rated',
      'VAT',
      'Total',
    ]) {
      expect(html).toContain(label);
    }
    for (const amount of [
      '18,80,000',
      '94,000',
      '17,86,000',
      '12,000',
      '3,500',
      '2,32,180',
      '20,18,180',
    ]) {
      expect(html).toContain(amount);
    }
  });

  it('shows the lines and the tax summary', async () => {
    const html = await render();
    expect(html).toContain('Advance 40% of the website build');
    expect(html).toContain('13%');
    expect(html).toContain('17,86,000');
  });

  it('shows the NPR snapshot with its rate for a foreign currency invoice', async () => {
    mocks.getInvoice.mockResolvedValue(
      issued({
        currency: 'USD',
        npr: {
          amountNpr: '2690000.00',
          rate: '133.500000',
          rateSource: 'NRB',
          rateDate: '2026-11-07',
        },
      }),
    );
    const html = await render();
    expect(html).toContain('26,90,000');
    expect(html).toContain('133.500000');
    expect(html).toContain('2026-11-07');
  });

  it('says the NPR value is fixed at issue while a foreign draft has none', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ currency: 'USD' }));
    expect(await render()).toMatch(/fixed when the invoice is issued/i);
  });

  it('shows no number yet on a draft, and the approval state', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail());
    const html = await render();
    expect(html).toContain('Not numbered yet');
    expect(html).toContain('Not submitted');
  });

  it('links the approval request while it is awaiting approval', async () => {
    mocks.getInvoice.mockResolvedValue(
      invoiceDetail({ status: 'submitted', approvalRequestId: APPROVAL }),
    );
    const html = await render();
    expect(html).toContain('Awaiting approval');
    expect(html).toContain(`href="/inbox/${APPROVAL}"`);
  });

  it('says a proforma needs no approval', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ kind: 'proforma' }));
    expect(await render()).toMatch(/no approval/i);
  });

  it('offers a dialog trigger for the issued PDF without a prefetching download link', async () => {
    const html = await render();
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*Preview invoice<\/button>/);
    expect(html).not.toMatch(/<a[^>]+href="\/invoices\/[^"]+\/document"/);
  });

  it.each(['draft', 'submitted', 'returned', 'approved'])(
    'offers no PDF link while the invoice is %s',
    async (status) => {
      mocks.getInvoice.mockResolvedValue(invoiceDetail({ status }));
      const html = await render();
      expect(html).not.toContain('/document"');
      expect(html).toMatch(/PDF is made when the invoice is issued/i);
    },
  );

  it('says a discarded invoice has no PDF', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ status: 'discarded' }));
    const html = await render();
    expect(html).not.toContain('/document"');
    expect(html).toMatch(/discarded invoice has no PDF/i);
  });

  it('offers no PDF for a proforma', async () => {
    mocks.getInvoice.mockResolvedValue(issued({ kind: 'proforma', number: 'PI-2083/84-00001' }));
    expect(await render()).not.toContain('/document"');
  });

  it('links a credit note to the invoice it corrects, with its reason', async () => {
    mocks.getInvoice.mockResolvedValue(
      issued({
        kind: 'credit_note',
        originalInvoiceId: SALES_ORDER,
        noteReason: 'Scope cut by half',
      }),
    );
    const html = await render();
    expect(html).toContain(`href="/invoices/${SALES_ORDER}"`);
    expect(html).toContain('Scope cut by half');
  });

  it('links to the customer by id before a buyer snapshot exists, with no second fetch', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail());
    const html = await render();
    expect(html).toContain(`href="/customers/${CUSTOMER}"`);
    expect(mocks.getInvoice).toHaveBeenCalledTimes(1);
  });

  it('mounts the note-button slot only for Finance on an issued tax invoice', async () => {
    expect(await render()).toContain('data-slot="invoice-note-actions"');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    expect(await render()).not.toContain('data-slot="invoice-note-actions"');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
    mocks.getInvoice.mockResolvedValue(invoiceDetail());
    expect(await render()).not.toContain('data-slot="invoice-note-actions"');
  });

  it('puts the Credit note and Debit note buttons into the slot for Finance, and asks for tax codes only then', async () => {
    const html = await render();
    expect(html).toMatch(/<button[^>]*>Credit note<\/button>/);
    expect(html).toMatch(/<button[^>]*>Debit note<\/button>/);
    expect(mocks.listTaxCodes).toHaveBeenCalledTimes(1);
    mocks.listTaxCodes.mockClear();
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    const other = await render();
    expect(other).not.toMatch(/>Credit note<\/button>/);
    expect(mocks.listTaxCodes).not.toHaveBeenCalled();
  });

  it('still opens the detail and offers the note dialogs when tax codes fail to load', async () => {
    mocks.listTaxCodes.mockRejectedValue(new Error('down'));
    const html = await render();
    expect(html).toContain('Invoice details');
    expect(html).toMatch(/<button[^>]*>Debit note<\/button>/);
  });

  it('puts the actions the role may take into the action slot, and none on an issued invoice', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getInvoice.mockResolvedValue(invoiceDetail());
    const draft = await render();
    expect(draft).toContain('Submit for approval');
    expect(draft).toContain('Discard');
    expect(draft).not.toContain('Issue tax invoice');

    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ status: 'approved' }));
    expect(await render()).toContain('Issue tax invoice');

    mocks.getInvoice.mockResolvedValue(issued());
    const done = await render();
    expect(done).not.toContain('Issue tax invoice');
    expect(done).not.toContain('Submit for approval');
  });

  it('keeps a long manual reason in the page, where it wraps', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ manualReason: 'x'.repeat(900) }));
    expect(await render()).toContain('x'.repeat(900));
  });

  it('calls notFound for an id that is not a UUID, without asking the API', async () => {
    await expect(render('../admin')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.getInvoice).not.toHaveBeenCalled();
    expect(mocks.requireStaffSession).not.toHaveBeenCalled();
  });

  it('calls notFound for a 404', async () => {
    mocks.getInvoice.mockRejectedValue(new ApiError(404, 'gone'));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('shows the no-access notice for a 403', async () => {
    mocks.getInvoice.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include invoices');
    expect(html).not.toContain('Subtotal');
  });

  it('shows the error and a retry link for a 500', async () => {
    mocks.getInvoice.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('This invoice did not load');
    expect(html).toContain(`href="/invoices/${ID}"`);
  });
});
