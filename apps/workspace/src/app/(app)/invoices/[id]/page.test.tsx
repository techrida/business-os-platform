import { InvoiceDetailSchema, PaymentPromiseListSchema, type InvoiceDetail } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS } from '@bos/locale';
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
  getCustomerStatement: vi.fn(),
  getApprovalRequest: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  getSession: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-billing')>()),
  getInvoice: mocks.getInvoice,
}));
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  getApprovalRequest: mocks.getApprovalRequest,
}));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: mocks.listTaxCodes }));
vi.mock('@/lib/api-receivables', () => ({ getCustomerStatement: mocks.getCustomerStatement }));
// GET /v1/me for an unedited role answers the role's default grants.
vi.mock('@/lib/live-permissions', async () => {
  const { permissionChecker } = await import('@/components/p2/customers/permissions');
  return {
    // A session may name its exact permissions instead, for a mix no default role has.
    getPermissionCheck: (s: { roles: string[]; permissions?: string[] }) =>
      Promise.resolve(
        s.permissions !== undefined
          ? (p: string) => s.permissions?.includes(p) === true
          : permissionChecker(s.roles),
      ),
  };
});
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// The tenant's display settings come through the real `getDisplaySettings` read; only the session and the HTTP call
// under it are stubbed. No session (the default) means the default settings.
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  getSession: mocks.getSession,
}));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
// A marked anchor, so a test can tell the PDF link (a plain anchor) from a prefetching Link.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href} data-next-link="">
      {children}
    </a>
  ),
}));

// The real viewer, with the routes it was given written beside its trigger, so a test can see whether Retry is
// offered (the dialog only asks for it once opened).
vi.mock('@/components/ui/file-preview-dialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/components/ui/file-preview-dialog')>();
  return {
    ...real,
    FilePreviewDialog: (props: Parameters<typeof real.FilePreviewDialog>[0]) => (
      <span data-download-url={props.downloadUrl} data-retry-url={props.retryUrl}>
        <real.FilePreviewDialog {...props} />
      </span>
    ),
  };
});

async function render(id: string = ID): Promise<string> {
  return renderToStaticMarkup(await InvoiceDetailPage({ params: Promise.resolve({ id }) }));
}

const issued = (over: Record<string, unknown> = {}) =>
  invoiceDetail({ status: 'issued', approvalRequestId: APPROVAL, ...over });

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.getInvoice.mockReset().mockResolvedValue(issued());
  mocks.listTaxCodes.mockReset().mockResolvedValue([{ id: TAX, label: 'VAT 13%' }]);
  mocks.getCustomerStatement.mockReset().mockResolvedValue([]);
  mocks.getApprovalRequest.mockReset().mockRejectedValue(new Error('not read'));
  mocks.notFound.mockClear();
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.apiFetch.mockReset();
});

/** The tenant's display settings as `GET /v1/settings/display` answers them. */
function tenantDisplay(body: Record<string, unknown>) {
  mocks.getSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.apiFetch.mockImplementation(() =>
    Response.json({
      numberSystems: DEFAULT_NUMBER_SYSTEMS,
      dateFormat: 'dd MMM yyyy',
      enabledCurrencies: ['NPR', 'USD'],
      sellerContact: null,
      ...body,
    }),
  );
}

/** An invoice detail with the first print's frozen format, checked against the contract. */
const withFormat = (detail: InvoiceDetail, format: unknown): InvoiceDetail =>
  InvoiceDetailSchema.parse({ ...detail, format });

const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('invoice detail page', () => {
  it("shows a note's creator Issue off with the reason, from the API's issueBlockedBySod (TR-Q12f)", async () => {
    const note = (blocked: boolean) =>
      InvoiceDetailSchema.parse({
        ...invoiceDetail({
          kind: 'debit_note',
          status: 'approved',
          salesOrderId: null,
          originalInvoiceId: APPROVAL,
          noteReason: 'Extra support day',
        }),
        ...(blocked ? { issueBlockedBySod: true } : {}),
      });
    mocks.getInvoice.mockResolvedValue(note(true));
    const blocked = await render();
    expect(blocked).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Issue debit note<\/button>/);
    expect(blocked).toContain(
      'You created this note, so someone else with issue access must issue it.',
    );

    mocks.getInvoice.mockResolvedValue(note(false));
    const open = await render();
    expect(open).not.toContain('aria-disabled="true"');
    expect(open).not.toContain('You created this note');
  });

  it('shows number, issue date (AD and BS) and the buyer, all as read-only text', async () => {
    const html = await render();
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain('23 Kartik 2083 BS');
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

  /** An issued invoice with the settlement `GET /v1/invoices/:id` derives, checked against the contract. */
  const settled = (settlement: string | null, openAmount: string | null) =>
    InvoiceDetailSchema.parse({ ...issued(), settlement, openAmount });

  it('shows a fully paid invoice as Paid with a zero open amount, from the detail', async () => {
    mocks.getInvoice.mockResolvedValue(settled('paid', '0.00'));
    const text = textOf(await render());
    expect(text).toContain('Paid');
    expect(text).toMatch(/Open amount\s+[^0-9]*0\.00/);
    // The settlement rides on the detail; the ar.read-gated statement is never asked.
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
  });

  it('shows a partly paid invoice with its open amount in lakh grouping', async () => {
    mocks.getInvoice.mockResolvedValue(settled('partly_paid', '1018180.00'));
    const text = textOf(await render());
    expect(text).toContain('Partly paid');
    expect(text).toContain('10,18,180.00');
  });

  it('shows no payment position on a draft, or when the detail carries none', async () => {
    mocks.getInvoice.mockResolvedValue(
      InvoiceDetailSchema.parse({
        ...invoiceDetail({ status: 'draft' }),
        settlement: null,
        openAmount: null,
      }),
    );
    expect(textOf(await render())).not.toContain('Open amount');

    // An older API answer without the fields.
    mocks.getInvoice.mockResolvedValue(issued());
    expect(textOf(await render())).not.toContain('Open amount');
  });

  it('offers Record payment for the customer while the invoice is still owed', async () => {
    const RECORD = `href="/payments/new?customerId=${CUSTOMER}"`;
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getInvoice.mockResolvedValue(settled('overdue', '2018180.00'));
    expect(await render()).toContain(RECORD);

    // Paid: nothing left to record against it.
    mocks.getInvoice.mockResolvedValue(settled('paid', '0.00'));
    expect(await render()).not.toContain('Record payment');

    // Owed, but the role does not record payments.
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getInvoice.mockResolvedValue(settled('unpaid', '2018180.00'));
    expect(await render()).not.toContain('Record payment');
  });

  it('offers Record payment to someone with invoice.read and payment.record but no ar.read', async () => {
    mocks.requireStaffSession.mockResolvedValue({
      accessToken: 't',
      roles: [],
      permissions: ['invoice.read', 'payment.record'],
    });
    mocks.getInvoice.mockResolvedValue(settled('unpaid', '2018180.00'));
    const html = await render();
    // Old code read the settlement from the ar.read-gated statement, so the button hid here.
    expect(html).toContain(`href="/payments/new?customerId=${CUSTOMER}"`);
    expect(html).toContain('Record payment');
    expect(textOf(html)).toMatch(/Open amount\s+[^0-9]*20,18,180\.00/);
  });

  it('offers no Record payment when the settlement is unknown', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    // Left out by an older API: never read as "offer on every issued invoice".
    mocks.getInvoice.mockResolvedValue(issued());
    expect(await render()).not.toContain('Record payment');
    mocks.getInvoice.mockResolvedValue(settled(null, null));
    expect(await render()).not.toContain('Record payment');
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

  it('offers a View PDF dialog trigger for the issued PDF without a prefetching download link', async () => {
    const html = await render();
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>.*View PDF<\/button>/);
    expect(html).not.toMatch(/<a[^>]+href="\/invoices\/[^"]+\/document"/);
  });

  // R4c2 (TR-Q4): a PDF whose render was given up offers Retry to who may issue the invoice, and to no one else.
  it('offers Retry on the PDF to Finance, who may issue the invoice', async () => {
    const html = await render();
    expect(html).toContain(`data-retry-url="/invoices/${ID}/document/retry"`);
    expect(html).toContain(`data-download-url="/invoices/${ID}/document"`);
  });

  // `can` is what the API sends for this invoice: the issue grant judged on the record (an `own` grant only on the
  // invoices the caller drafted), not the invoice's state, so it stays true on an issued invoice.
  it('offers Retry when the API says the caller may issue this invoice, and not when it says no', async () => {
    const can = { submit: false, issue: true, discard: false, notes: true, recordPayment: true };
    mocks.getInvoice.mockResolvedValue({ ...issued(), can });
    expect(await render()).toContain(`data-retry-url="/invoices/${ID}/document/retry"`);
    mocks.getInvoice.mockResolvedValue({ ...issued(), can: { ...can, issue: false } });
    const html = await render();
    expect(html).toMatch(/View PDF/);
    expect(html).not.toContain('data-retry-url');
  });

  it('offers no Retry on the PDF to the Accountant, who may not issue', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    const html = await render();
    expect(html).toMatch(/View PDF/);
    expect(html).not.toContain('data-retry-url');
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

  it('labels a debit note by its kind: Issued to, Debit note no., Debit note details, never "Invoice"', async () => {
    mocks.getInvoice.mockResolvedValue(
      InvoiceDetailSchema.parse({
        ...invoiceDetail({
          kind: 'debit_note',
          status: 'approved',
          salesOrderId: null,
          originalInvoiceId: APPROVAL,
          noteReason: 'Extra support day',
        }),
      }),
    );
    const html = textOf(await render());
    expect(html).toContain('Issued to');
    expect(html).toContain('Debit note no.');
    expect(html).toContain('Debit note details');
    expect(html).not.toContain('Invoice to');
    expect(html).not.toContain('Invoice no.');
    expect(html).not.toContain('Invoice details');
  });

  it('shows who acted and when from the approval read, and leaves the panel out when it is refused', async () => {
    const approval = {
      requestId: APPROVAL,
      documentType: 'tax_invoice',
      documentId: ID,
      documentNumber: 'INV-1',
      status: 'approved',
      blockReason: null,
      currentSeq: 1,
      version: 1,
      requesterUserId: CUSTOMER,
      snapshot: {},
      steps: [],
      actions: [
        {
          action: 'approve',
          actorUserId: CUSTOMER,
          onBehalfOfUserId: null,
          comment: 'Checked against the order',
          createdAt: '2026-11-20T06:00:00.000Z',
        },
      ],
      people: [{ userId: CUSTOMER, name: 'Ada Lovelace' }],
      submittedAt: '2026-11-19T06:00:00.000Z',
      decidedAt: '2026-11-20T06:00:00.000Z',
    };
    mocks.getApprovalRequest.mockResolvedValue(approval);
    const html = textOf(await render());
    expect(html).toContain('Approval history');
    expect(html).toContain('Approved by Ada Lovelace');
    expect(html).toContain('Checked against the order');
    mocks.getApprovalRequest.mockRejectedValue(new Error('forbidden'));
    expect(textOf(await render())).not.toContain('Approval history');
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

describe('invoice detail page: the document', () => {
  it("writes numbers, dates and words in the first print's format, not today's settings", async () => {
    // Today the tenant prints lakh grouping and `dd MMM yyyy`; the original PDF was drawn international and dd/MM/yyyy.
    tenantDisplay({
      numberSystems: { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' },
      dateFormat: 'dd MMM yyyy',
    });
    mocks.getInvoice.mockResolvedValue(
      withFormat(issued(), {
        numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
        dateFormat: 'dd/MM/yyyy',
        capturedAt: '2026-11-08T06:00:00.000Z',
      }),
    );
    const text = textOf(await render());
    expect(text).toContain('NPR 2,018,180.00');
    expect(text).not.toContain('20,18,180');
    expect(text).toContain('08/11/2026');
    expect(text).toContain('08/12/2026');
    expect(text).not.toContain('08 Nov 2026');
    expect(text).toContain('Two Million Eighteen Thousand One Hundred Eighty Rupees Only');
  });

  it("falls back to the tenant's current settings when the invoice has no first-print format", async () => {
    tenantDisplay({
      numberSystems: { NPR: 'international', INR: 'south_asian', USD: 'international' },
      dateFormat: 'MMM dd, yyyy',
    });
    mocks.getInvoice.mockResolvedValue(withFormat(issued(), null));
    const text = textOf(await render());
    expect(text).toContain('NPR 2,018,180.00');
    expect(text).toContain('Nov 08, 2026');
    expect(text).toContain('Dec 08, 2026');
  });

  it('says the amount in words in lakh and crore under the default south-Asian grouping', async () => {
    const text = textOf(await render());
    expect(text).toContain(
      'Amount in words: Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only',
    );
    expect(text).not.toContain('Million');
  });

  it('prints the issue date with its frozen BS form and the due date with its converted BS form', async () => {
    const text = textOf(await render());
    // One long BS form on the document (U16-Q5); the compact form stays out.
    expect(text).toContain('(23 Kartik 2083 BS)');
    expect(text).not.toContain('2083-07-23');
    expect(text).toMatch(/\(\d{2} [A-Za-z]+ 2083 BS\)/);
    expect(text).toMatch(/Due 08 Dec 2026 · 30 days/);
  });

  it('shows a draft with no number, issue date or frozen seller and buyer, and says when they are set', async () => {
    mocks.getInvoice.mockResolvedValue(
      invoiceDetail({ status: 'draft' }, { customerName: 'Himalayan Agro Foods' }),
    );
    const text = textOf(await render());
    expect(text).toContain('Not numbered yet');
    expect(text).toContain('Set when the invoice is issued');
    expect(text).toContain('The seller details are fixed when it is issued.');
    expect(text).toContain('The billing details are fixed when it is issued.');
    expect(text).toContain('Himalayan Agro Foods');
    expect(text).not.toContain('INV-');
    expect(text).not.toContain('Techrida Pvt. Ltd.');
  });

  it("shows the seller's phones, email and signatory from the display read, with the frozen address and PAN/VAT", async () => {
    tenantDisplay({
      sellerContact: {
        phones: ['+977 1 4000000', '+977 9800000000'],
        email: 'billing@techrida.example',
        signatoryName: 'Amanda Vance',
        signatoryTitle: 'Finance Director',
      },
    });
    const html = await render();
    const text = textOf(html);
    for (const part of [
      '+977 1 4000000',
      '+977 9800000000',
      'billing@techrida.example',
      'Amanda Vance',
      'Finance Director',
      'Authorised signatory',
      'Techrida Pvt. Ltd.',
      '123456789',
    ]) {
      expect(text).toContain(part);
    }
    expect(html).toMatch(/<footer>.*Kathmandu.*<\/footer>/s);
  });

  it('lists the items as a table with the columns the PDF prints', async () => {
    const html = await render();
    for (const head of ['#', 'Description', 'Unit', 'Qty', 'Price', 'Amount']) {
      expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${head}</th>`));
    }
    expect(html).toContain('data-label="Amount"');
    expect(textOf(html)).toContain('lot');
  });
});

describe('invoice detail under the per-invoice can flags', () => {
  const OTHERS = {
    submit: false,
    issue: false,
    discard: false,
    notes: false,
    recordPayment: false,
  };
  const OWN = { submit: true, issue: true, discard: true, notes: true, recordPayment: true };
  const RECORD = `href="/payments/new?customerId=${CUSTOMER}"`;
  const SUBMIT = />Submit for approval</;
  const ISSUE = />Issue tax invoice</;
  const NOTE = />Credit note</;
  /** An issued invoice still owed in full, as the detail derives it. */
  const owed = () =>
    InvoiceDetailSchema.parse({ ...issued(), settlement: 'unpaid', openAmount: '2018180.00' });

  it("hides Submit, Issue, the notes and Record payment on another person's invoice", async () => {
    // Finance holds every one of these permissions; only the API's can says this invoice is out of reach.
    mocks.getInvoice.mockResolvedValue({ ...invoiceDetail({ status: 'draft' }), can: OTHERS });
    expect(await render()).not.toMatch(SUBMIT);
    mocks.getInvoice.mockResolvedValue({ ...invoiceDetail({ status: 'approved' }), can: OTHERS });
    expect(await render()).not.toMatch(ISSUE);
    mocks.getInvoice.mockResolvedValue({ ...owed(), can: OTHERS });
    const out = await render();
    expect(out).not.toMatch(NOTE);
    expect(out).not.toContain(RECORD);
  });

  it("offers them on the person's own invoice", async () => {
    mocks.getInvoice.mockResolvedValue({ ...invoiceDetail({ status: 'draft' }), can: OWN });
    expect(await render()).toMatch(SUBMIT);
    mocks.getInvoice.mockResolvedValue({ ...invoiceDetail({ status: 'approved' }), can: OWN });
    expect(await render()).toMatch(ISSUE);
    mocks.getInvoice.mockResolvedValue({ ...owed(), can: OWN });
    const out = await render();
    expect(out).toMatch(NOTE);
    expect(out).toContain(RECORD);
  });

  it('keeps the grant-only behaviour when the detail comes without can', async () => {
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ status: 'draft' }));
    expect(await render()).toMatch(SUBMIT);
    mocks.getInvoice.mockResolvedValue(owed());
    const out = await render();
    expect(out).toMatch(NOTE);
    expect(out).toContain(RECORD);
  });
});

describe('promise to pay card', () => {
  const PROMISES = `/v1/receivables/invoices/${ID}/promises`;
  /** `GET .../promises` as the API answers it, checked against the contract; every other call answers nothing. */
  function promisesAnswer(res: () => Response) {
    mocks.apiFetch.mockImplementation((_session: unknown, path: string) =>
      path === PROMISES ? Promise.resolve(res()) : Promise.resolve(undefined),
    );
  }
  const list = PaymentPromiseListSchema.parse({
    items: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        invoiceId: ID,
        promisedDate: '2026-12-01',
        note: 'Pays after the harvest sale',
        status: 'open',
        recordedByUserId: '55555555-5555-4555-8555-555555555555',
        missedAt: null,
        collectionActivityId: null,
        createdAt: '2026-11-20T04:00:00.000Z',
        recordedByName: 'Asha Rai',
        updatedAt: '2026-11-20T04:00:00.000Z',
      },
    ],
    can: { record: true, reason: null },
  });
  const promiseCalls = () =>
    mocks.apiFetch.mock.calls.filter((call: unknown[]) => call[1] === PROMISES);

  it("shows the open promise and Record promise from the API's list on an issued tax invoice", async () => {
    promisesAnswer(() => Response.json(list));
    const out = textOf(await render());
    expect(promiseCalls()).toHaveLength(1);
    expect(out).toContain('Promise to pay');
    expect(out).toContain('Pays after the harvest sale');
    expect(out).toContain('Recorded by Asha Rai');
    expect(out).toContain('Record promise');
  });

  it('leaves the card out, and the invoice standing, when the API refuses the list (403)', async () => {
    promisesAnswer(() => Response.json({ error: { code: 'forbidden' } }, { status: 403 }));
    const out = textOf(await render());
    expect(promiseCalls()).toHaveLength(1);
    expect(out).not.toContain('Promise to pay');
    expect(out).toContain('INV-2083/84-00001');
  });

  it('asks for no promises on a draft, or for a role without ar.read', async () => {
    promisesAnswer(() => Response.json(list));
    mocks.getInvoice.mockResolvedValue(invoiceDetail({ status: 'draft' }));
    expect(textOf(await render())).not.toContain('Promise to pay');
    mocks.getInvoice.mockResolvedValue(issued());
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    const out = textOf(await render());
    expect(out).toContain('INV-2083/84-00001');
    expect(out).not.toContain('Promise to pay');
    expect(promiseCalls()).toHaveLength(0);
  });
});
