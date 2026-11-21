import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['accountant'] as string[] }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles }),
}));
// GET /v1/me for an unedited role answers the role's default grants; a test sets `live` for an edited one.
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: () =>
      Promise.resolve(
        grants.live ??
          new Map(
            session.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/payables/bills',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  matchBillAction: vi.fn(),
  submitBillAction: vi.fn(),
  voidBillAction: vi.fn(),
  discardBillAction: vi.fn(),
  convertSubmissionAction: vi.fn(),
  rejectSubmissionAction: vi.fn(),
  requestExceptionAction: vi.fn(),
  createBillAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listBillsPage: vi.fn(),
  getBill: vi.fn(),
  listBillSubmissions: vi.fn(),
  listBillSubmissionsPage: vi.fn(),
  getPoProgress: vi.fn(),
  getVendor: vi.fn(),
  listTaxCodes: vi.fn(),
  listExpenseAccounts: vi.fn(),
  listWithholdingCodes: vi.fn(),
  listVendors: vi.fn(),
  listBillableOrders: vi.fn(),
  getApprovalRequest: vi.fn(),
  listPaymentRequestItems: vi.fn(),
  loadEnabledCurrencies: vi.fn(),
}));
vi.mock('@/lib/api-payables-orders', () => ({
  listBillableOrders: api.listBillableOrders,
  ORDER_PICKER_LIMIT: 200,
}));
vi.mock('@/lib/api-payables', () => ({
  listBillsPage: api.listBillsPage,
  getBill: api.getBill,
  listBillSubmissions: api.listBillSubmissions,
  listBillSubmissionsPage: api.listBillSubmissionsPage,
  listPaymentRequestItems: api.listPaymentRequestItems,
}));
vi.mock('@/lib/enabled-currencies.server', () => ({
  loadEnabledCurrencies: api.loadEnabledCurrencies,
}));
vi.mock('@/lib/api-purchase-orders', () => ({ getPoProgress: api.getPoProgress }));
vi.mock('@/lib/api-kernel', async (original) => ({
  ...(await original<typeof import('@/lib/api-kernel')>()),
  getApprovalRequest: api.getApprovalRequest,
}));
vi.mock('@/lib/api-vendors', () => ({ getVendor: api.getVendor, listVendors: api.listVendors }));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: api.listTaxCodes }));
vi.mock('@/lib/api-company-accounts', () => ({ listExpenseAccounts: api.listExpenseAccounts }));
vi.mock('@/lib/api-withholding-codes', () => ({ listWithholdingCodes: api.listWithholdingCodes }));

const { default: BillsPage } = await import('./bills/page');
const { default: BillPage } = await import('./bills/[id]/page');
const { default: NewBillPage } = await import('./bills/new/page');
const { default: InboxPage } = await import('./inbox/page');

const BILL = '11111111-1111-4111-8111-111111111111';
const VENDOR = '22222222-2222-4222-8222-222222222222';
const PO = '33333333-3333-4333-8333-333333333333';
const POLINE = '44444444-4444-4444-8444-444444444444';
const SUB = '55555555-5555-4555-8555-555555555555';
const DOC = '66666666-6666-4666-8666-666666666666';
// The bill line fixture books to VENDOR's id, so this account is the one it names.
const OFFICE = {
  id: VENDOR,
  code: '5100',
  name: 'Office supplies',
  status: 'active',
  retiredAt: null,
};

const apiError = (status: number, code = 'x') =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678' },
  });

const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);

const header = {
  id: BILL,
  kind: 'bill',
  number: 'BILL-2083-0001',
  vendorPartyId: VENDOR,
  vendorName: 'Himal Traders',
  vendorInvoiceNo: 'INV-001',
  invoiceDate: '2026-11-08',
  fiscalYear: '2083/84',
  currency: 'NPR',
  purchaseOrderId: PO,
  purchaseOrderNumber: 'PO-2083-0007',
  documentId: DOC,
  status: 'variance',
  matchStatus: 'variance',
  netTotal: '2000.00',
  vatTotal: '260.00',
  tdsTotal: '0.00',
  payableTotal: '1234567.00',
  enteredBy: VENDOR,
  approvalRequestId: null,
  version: 2,
};
const line = {
  id: POLINE,
  lineNo: 1,
  poLineId: POLINE,
  receiptLineId: null,
  description: 'Laptop with a very long description '.repeat(4),
  accountId: VENDOR,
  quantity: '2.0000',
  unitPrice: '1000.00',
  netAmount: '2000.00',
  taxCodeId: VENDOR,
  vatAmount: '260.00',
  tdsCodeId: null,
  tdsAmount: '0.00',
  match: {
    runNo: 1,
    status: 'variance',
    receivedQuantity: null,
    billedQuantity: '2.0000',
    quantityVariance: '2.0000',
    priceVariance: '100.00',
    taxVariance: '13.00',
  },
};
const submission = {
  id: SUB,
  vendorPartyId: VENDOR,
  vendorName: 'Himal Traders',
  purchaseOrderId: PO,
  vendorInvoiceNo: 'INV-001',
  invoiceDate: '2026-11-08',
  documentId: DOC,
  fileStatus: 'clean',
  note: null,
  status: 'received',
  receivedAt: '2026-11-08T05:45:00.000Z',
  claimedTotal: null,
  currency: null,
  duplicates: [],
};
const progress = {
  vendorId: VENDOR,
  vendorName: 'Himal Traders',
  purchaseOrderId: PO,
  number: 'PO-2083-0007',
  status: 'issued',
  lines: [
    {
      poLineId: POLINE,
      lineNo: 1,
      kind: 'goods',
      description: 'Laptop',
      uom: 'pcs',
      requiresSerials: false,
      orderedQuantity: '10.0000',
      cancelledQuantity: '0.0000',
      receivedQuantity: '4.0000',
      pendingQuantity: '0.0000',
      openQuantity: '6.0000',
      billedQuantity: '0.0000',
    },
  ],
};

beforeEach(() => {
  session.roles = ['accountant'];
  grants.live = undefined;
  for (const fn of Object.values(api)) fn.mockReset();
  api.getVendor.mockResolvedValue({ legalName: 'Himal Traders' });
  api.getPoProgress.mockResolvedValue(progress);
  api.listTaxCodes.mockResolvedValue([{ id: VENDOR, label: 'VAT 13%' }]);
  api.listExpenseAccounts.mockResolvedValue([OFFICE]);
  api.listWithholdingCodes.mockResolvedValue([
    {
      id: VENDOR,
      code: 'TDS0',
      name: 'Pending accountant signoff',
      rateBp: 0,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
  ]);
  api.listVendors.mockResolvedValue({
    items: [{ id: VENDOR, legalName: 'Himal Traders' }],
    total: 1,
  });
  api.listBillableOrders.mockResolvedValue([]);
  api.getApprovalRequest.mockRejectedValue(apiError(403, 'forbidden'));
  api.listPaymentRequestItems.mockResolvedValue([]);
  api.loadEnabledCurrencies.mockResolvedValue(['NPR']);
});

const page = (items: unknown[], total = items.length) => ({ items, total });
const bills = (sp: Record<string, string | string[]> = {}) =>
  html(BillsPage({ searchParams: Promise.resolve(sp) }));

describe('bills list', () => {
  it('shows each bill with lakh-grouped money, and sends repeated statuses, the search and the page window', async () => {
    api.listBillsPage.mockResolvedValue(page([{ ...header, payableTotal: '1234567.00' }]));
    const out = await bills({ status: ['variance', 'bogus', 'draft'], q: 'INV', page: '2' });
    expect(api.listBillsPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['variance', 'draft'],
      q: 'INV',
      limit: 25,
      offset: 25,
    });
    expect(out).toContain('BILL-2083-0001');
    expect(out).toContain('INV-001');
    expect(out).toContain('Himal Traders');
    expect(out).toContain('12,34,567.00');
  });

  it('shows the total beyond the page, the range and no Apply or Show button', async () => {
    api.listBillsPage.mockResolvedValue(page([header], 240));
    const out = await bills();
    expect(api.listBillsPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      limit: 25,
      offset: 0,
    });
    expect(out).toContain('Showing 1 of 240 bills');
    expect(out).toContain('Showing 1–25 of 240');
    expect(out).toContain('type="search"');
    expect(out).not.toContain('Show bills');
  });

  it('says so when there are no bills, and points an accountant to the inbox', async () => {
    api.listBillsPage.mockResolvedValue(page([]));
    const out = await bills();
    expect(out).toContain('No bills yet.');
    expect(out).toContain('/payables/inbox');
  });

  it('names the filters that match none and offers Clear filters', async () => {
    api.listBillsPage.mockResolvedValue(page([]));
    const out = await bills({ status: 'variance', q: 'zzz', rows: '50' });
    expect(out).toContain('No bills match.');
    expect(out).toContain('Status: ');
    expect(out).toContain('zzz');
    expect(out).toContain('Clear filters');
    expect(out).toContain('rows=50');
  });

  it('counts each card with one limit-1 read through the scoped list, ignoring the filters', async () => {
    api.listBillsPage.mockImplementation((_s: unknown, q: { status: string[]; limit: number }) =>
      Promise.resolve(
        q.limit === 1 ? page([header], q.status.length === 0 ? 40 : 7) : page([header]),
      ),
    );
    const out = await bills({ status: 'draft', q: 'INV' });
    const countReads = api.listBillsPage.mock.calls
      .map((call) => call[1] as { limit: number })
      .filter((q) => q.limit === 1);
    expect(countReads).toEqual([
      { status: [], limit: 1, offset: 0 },
      { status: ['variance', 'exception_pending'], limit: 1, offset: 0 },
      { status: ['pending_approval'], limit: 1, offset: 0 },
      { status: ['approved', 'partially_paid'], limit: 1, offset: 0 },
      { status: ['paid'], limit: 1, offset: 0 },
    ]);
    expect(out).toContain('aria-label="Bill summary"');
    expect(out).toMatch(/All bills<\/dt><dd[^>]*>40</);
    expect(out).toMatch(/Approved to pay<\/dt><dd[^>]*>7</);
  });

  it('leaves the cards out, and still shows the table, when a count read fails', async () => {
    api.listBillsPage.mockImplementation((_s: unknown, q: { limit: number }) =>
      q.limit === 1 ? Promise.reject(apiError(500)) : Promise.resolve(page([header])),
    );
    const out = await bills();
    expect(out).not.toContain('Bill summary');
    expect(out).toContain('BILL-2083-0001');
  });

  it('pins Status and a View action to the end of each row, named per row, with rows per page', async () => {
    api.listBillsPage.mockResolvedValue(
      page([
        { ...header, number: null, id: SUB },
        { ...header, number: null, id: DOC, vendorInvoiceNo: 'INV-002' },
      ]),
    );
    const out = await bills();
    const heads = [...out.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads.slice(-2)).toEqual(['Status', 'Action']);
    expect(out).toContain(`href="/payables/bills/${SUB}"`);
    const names = [...out.matchAll(/aria-label="(View [^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      'View draft bill for invoice INV-001 from Himal Traders',
      'View draft bill for invoice INV-002 from Himal Traders',
    ]);
    expect(out).toContain('aria-label="Rows per page"');
  });

  it('offers Request payment only to the payment request role, on a bill with a free balance, in any currency', async () => {
    const item = (billId: string, availableAmount: string, currency = 'NPR') => ({
      openItemId: billId,
      vendorPartyId: VENDOR,
      vendorName: 'Himal Traders',
      vendorBillId: billId,
      billNumber: null,
      vendorInvoiceNo: 'INV-001',
      currency,
      openAmount: '100.00',
      claimedAmount: '0.00',
      availableAmount,
    });
    api.listBillsPage.mockResolvedValue(
      page([
        { ...header, id: SUB, status: 'approved' },
        { ...header, id: DOC, status: 'approved', vendorInvoiceNo: 'INV-002' },
        { ...header, id: PO, status: 'approved', vendorInvoiceNo: 'INV-003' },
        { ...header, id: BILL, status: 'draft', vendorInvoiceNo: 'INV-004' },
      ]),
    );
    api.listPaymentRequestItems.mockResolvedValue([
      item(SUB, '90.00'),
      item(DOC, '0.00'),
      item(PO, '50.00', 'USD'),
    ]);
    session.roles = ['finance'];
    const out = await bills();
    const links = [...out.matchAll(/href="(\/payables\/payment-requests\/new[^"]*)"/g)].map(
      (m) => m[1],
    );
    // USD is switched off (only NPR is on), yet its bill is still requestable (D56 U16-Q1): payment requests are
    // exempt, so the list does not read the enabled currencies at all. Old code hid the link on the USD bill.
    expect(links).toEqual([
      `/payables/payment-requests/new?bill=${SUB}`,
      `/payables/payment-requests/new?bill=${PO}`,
    ]);
    expect(api.loadEnabledCurrencies).not.toHaveBeenCalled();
    expect(out).toContain(
      'aria-label="Request payment of BILL-2083-0001 for invoice INV-001 from Himal Traders"',
    );

    // An accountant cannot open the payment request form, so is offered no link and makes no read for it.
    session.roles = ['accountant'];
    api.listPaymentRequestItems.mockClear();
    expect(await bills()).not.toContain('Request payment');
    expect(api.listPaymentRequestItems).not.toHaveBeenCalled();

    // A failed lookup leaves the rows without the action, never without the list.
    session.roles = ['finance'];
    api.listPaymentRequestItems.mockRejectedValue(apiError(500));
    const failed = await bills();
    expect(failed).not.toContain('Request payment');
    expect(failed).toContain('INV-001');
  });

  it('reads the rows-per-page choice from the URL into the page window', async () => {
    api.listBillsPage.mockResolvedValue(page([header], 240));
    const out = await bills({ rows: '50', page: '2' });
    expect(api.listBillsPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      limit: 50,
      offset: 50,
    });
    expect(out).toContain('Showing 51–100 of 240');
    expect(out).toMatch(/<a[^>]*aria-current="true"[^>]*>50<\/a>/);
  });

  it('shows the no-access pattern for a 403 and a retry for a 500', async () => {
    api.listBillsPage.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await bills()).toContain('You cannot open the bills');
    api.listBillsPage.mockRejectedValue(apiError(500));
    const out = await bills();
    expect(out).toContain('The bills did not load');
    expect(out).toContain('Try again');
  });
});

describe('bill detail', () => {
  it('offers discard only for an accountant viewing a draft', async () => {
    api.getBill.mockResolvedValue({ ...header, status: 'draft', lines: [line] });
    expect(await html(BillPage({ params: Promise.resolve({ id: BILL }) }))).toContain(
      'Discard draft',
    );
    session.roles = ['finance'];
    expect(await html(BillPage({ params: Promise.resolve({ id: BILL }) }))).not.toContain(
      'Discard draft',
    );
    session.roles = ['accountant'];
    api.getBill.mockResolvedValue({ ...header, status: 'discarded', lines: [line] });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Discarded');
    expect(out).not.toContain('Discard draft');
  });
  it.each(['infected', 'scan_failed', 'rejected', null])(
    'offers invoice replacement for a draft with a non-clean file (%s)',
    async (fileStatus) => {
      api.getBill.mockResolvedValue({ ...header, status: 'draft', fileStatus, lines: [line] });
      const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
      expect(out).toContain('Upload a replacement file');
      expect(out).toContain('Replacement invoice file');
      expect(out).toContain('type="file"');
      expect(out).not.toContain('Void bill');
    },
  );

  it('hides replacement for clean or submitted bills and callers without bill entry', async () => {
    for (const [status, fileStatus, roles] of [
      ['draft', 'clean', ['accountant']],
      ['pending_approval', 'infected', ['accountant']],
      ['draft', 'infected', ['finance']],
    ]) {
      session.roles = roles as string[];
      api.getBill.mockResolvedValue({ ...header, status, fileStatus, lines: [line] });
      expect(await html(BillPage({ params: Promise.resolve({ id: BILL }) }))).not.toContain(
        'Upload a replacement file',
      );
    }
  });

  it('shows the match result, the variances, and what is blocked while outside tolerance', async () => {
    api.getBill.mockResolvedValue({ ...header, lines: [line] });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Himal Traders');
    expect(out).toContain('PO-2083-0007');
    expect(out).toContain('Nothing received');
    expect(out).toContain('100.00');
    expect(out).toContain('outside the tolerance');
    expect(out).toContain('Match again');
    expect(out).toContain('Request match exception');
    expect(out).not.toContain('Submit for approval');
    expect(out).not.toContain('Void bill');
  });

  it('offers submit on a matched bill and void on an approved one, only to someone who can enter bills', async () => {
    api.getBill.mockResolvedValue({
      ...header,
      status: 'matching',
      matchStatus: 'matched',
      lines: [line],
    });
    expect(await html(BillPage({ params: Promise.resolve({ id: BILL }) }))).toContain(
      'Submit for approval',
    );
    api.getBill.mockResolvedValue({
      ...header,
      status: 'approved',
      matchStatus: 'matched',
      approvalRequestId: SUB,
      lines: [line],
    });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Void bill');
    expect(out).toContain(`/inbox/${SUB}`);
    session.roles = ['finance'];
    const finance = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(finance).not.toContain('Void bill');
  });

  it('shows the approval steps when the approval read answers, and leaves them out when it is refused', async () => {
    api.getBill.mockResolvedValue({
      ...header,
      status: 'approved',
      approvalRequestId: SUB,
      lines: [line],
    });
    api.getApprovalRequest.mockResolvedValue({
      status: 'approved',
      decidedAt: '2026-11-10T05:00:00.000Z',
      steps: [{ seq: 1, reason: 'Finance approves vendor bills', status: 'approved' }],
    });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(api.getApprovalRequest).toHaveBeenCalledWith(expect.anything(), SUB);
    expect(out).toContain('Approval history');
    expect(out).toContain('Finance approves vendor bills');
    api.getApprovalRequest.mockRejectedValue(apiError(403, 'forbidden'));
    const refused = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(refused).not.toContain('Approval history');
    expect(refused).toContain(`/inbox/${SUB}`);
  });

  it('puts the line tables after the totals, at full width', async () => {
    api.getBill.mockResolvedValue({ ...header, lines: [line] });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out.indexOf('Totals')).toBeLessThan(out.indexOf('Bill lines'));
    expect(out.indexOf('</aside>')).toBeLessThan(out.indexOf('Bill lines'));
  });

  it('links Finance to the read-only order, and keeps the order number when that read is refused', async () => {
    session.roles = ['finance'];
    api.getBill.mockResolvedValue({ ...header, status: 'pending_approval', lines: [line] });
    api.getPoProgress.mockRejectedValue(apiError(403, 'forbidden'));
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('PO-2083-0007');
    expect(out).not.toContain('An order');
    expect(out).toContain(`/procurement/orders/${PO}`);
  });

  it('still shows the bill when the vendor and the order cannot be read', async () => {
    api.getBill.mockResolvedValue({ ...header, lines: [line] });
    api.getVendor.mockRejectedValue(apiError(403));
    api.getPoProgress.mockRejectedValue(apiError(500));
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Himal Traders');
    expect(out).toContain('INV-001');
  });

  // The live grants decide, not the role defaults: each case below fails on the old role-default gate.
  it('offers bill actions and the order link to a role an admin granted them, whatever its defaults', async () => {
    session.roles = ['finance'];
    grants.live = new Map([
      ['payables.bill.read', 'own'],
      ['payables.bill.enter', 'own'],
      ['procurement.po.issue', 'own'],
    ]);
    api.getBill.mockResolvedValue({
      ...header,
      status: 'matching',
      matchStatus: 'matched',
      lines: [line],
    });
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Submit for approval');
    expect(out).toContain(`/procurement/orders/${PO}`);
  });

  it('hides bill actions from an accountant whose payables.bill.enter an admin removed', async () => {
    grants.live = new Map([['payables.bill.read', 'all']]);
    api.getBill.mockResolvedValue({ ...header, status: 'draft', lines: [line] });
    const draft = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(draft).toContain('INV-001');
    expect(draft).not.toContain('Discard draft');
    api.getBill.mockResolvedValue({
      ...header,
      status: 'approved',
      matchStatus: 'matched',
      approvalRequestId: SUB,
      lines: [line],
    });
    expect(await html(BillPage({ params: Promise.resolve({ id: BILL }) }))).not.toContain(
      'Void bill',
    );
  });

  it('answers not found for an id that is not a GUID without calling the API, and for a 404', async () => {
    await expect(BillPage({ params: Promise.resolve({ id: '../x' }) })).rejects.toThrow(
      'NOT_FOUND',
    );
    expect(api.getBill).not.toHaveBeenCalled();
    api.getBill.mockRejectedValue(apiError(404, 'not_found'));
    await expect(BillPage({ params: Promise.resolve({ id: BILL }) })).rejects.toThrow('NOT_FOUND');
  });
});

describe('bill entry', () => {
  const search = (submissionId?: string) =>
    Promise.resolve(submissionId === undefined ? {} : { submission: submissionId });

  it('opens standalone entry with a vendor picker, invoice details and upload', async () => {
    const out = await html(NewBillPage({ searchParams: search() }));
    expect(out).toContain('name="vendorPartyId"');
    expect(out).toContain('name="vendorInvoiceNo"');
    expect(out).toContain('name="invoiceDate"');
    expect(out).toContain('type="file"');
    expect(out).toContain('Upload invoice');
    expect(api.listBillSubmissions).not.toHaveBeenCalled();
  });

  it('puts Cancel and Create bill in the heading, submitting the bill form from outside it', async () => {
    const out = await html(NewBillPage({ searchParams: search() }));
    const heading = out.slice(0, out.indexOf('</h1>') + 400);
    const formId = /<form id="([^"]+)"/.exec(out)?.[1];
    expect(formId).toBeTruthy();
    expect(out).toMatch(new RegExp(`<button type="submit"[^>]*form="${formId}"[^>]*>Create bill<`));
    expect(out.indexOf('Create bill')).toBeLessThan(out.indexOf(`<form id="${formId}"`));
    expect(heading).toContain('New bill');
    expect(out.match(/<h1/g)).toHaveLength(1);
    // The vendor search stays its own GET form, beside the bill form and not inside it.
    expect(out.indexOf('action="/payables/bills/new"')).toBeLessThan(
      out.indexOf(`<form id="${formId}"`),
    );
  });

  it('names Bills in the trail, and the inbox too for a bill keyed from a submission', async () => {
    const trail = (out: string) =>
      [
        ...(/<nav aria-label="Breadcrumb"[\s\S]*?<\/nav>/.exec(out)?.[0] ?? '').matchAll(
          />([^<>]+)</g,
        ),
      ]
        .map((m) => m[1]?.trim())
        .filter(Boolean);
    expect(trail(await html(NewBillPage({ searchParams: search() })))).toEqual([
      'Bills',
      'New bill',
    ]);
    api.listBillSubmissions.mockResolvedValue([submission]);
    expect(trail(await html(NewBillPage({ searchParams: search(SUB) })))).toEqual([
      'Bills',
      'Inbox',
      'New bill',
    ]);
  });

  it('draws the invoice file as a drop zone over the real file picker', async () => {
    const out = await html(NewBillPage({ searchParams: search() }));
    expect(out).toContain('Drop the invoice here or choose a file');
    expect(out).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Invoice file<\/label>/);
    const id = /<label[^>]*for="([^"]+)"[^>]*>Invoice file<\/label>/.exec(out)?.[1];
    expect(out).toMatch(
      new RegExp(`<input[^>]*type="file"[^>]*id="${id}"|<input[^>]*id="${id}"[^>]*type="file"`),
    );
  });

  it('prefills the PO vendor and fixed lines using the progress read', async () => {
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ po: PO }) }));
    expect(api.getPoProgress).toHaveBeenCalledWith(expect.anything(), PO);
    expect(out).toContain('Himal Traders');
    expect(out).toContain(`name="purchaseOrderId" value="${PO}"`);
    expect(out).toContain(`name="vendorPartyId" value="${VENDOR}"`);
    expect(out).not.toContain('Add a line');
  });

  it('does not silently turn a malformed PO URL into a non-PO bill', async () => {
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ po: '../wrong' }) }));
    expect(out).toContain('purchase order');
    expect(out).not.toContain('Create bill');
    expect(api.getPoProgress).not.toHaveBeenCalled();
  });

  it('points a malformed PO link at a fresh bill, naming no button that does not exist', async () => {
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ po: '../wrong' }) }));
    expect(out).toContain('That link does not name a valid purchase order');
    expect(out).toContain('href="/payables/bills/new"');
    expect(out).toContain('Start a new bill');
    expect(out).not.toContain('choose Enter bill');
  });

  it('loads the billable orders for the standalone picker, and enters without one if they fail', async () => {
    await html(NewBillPage({ searchParams: search() }));
    expect(api.listBillableOrders).toHaveBeenCalledOnce();
    api.listBillableOrders.mockClear();
    await html(NewBillPage({ searchParams: Promise.resolve({ po: PO }) }));
    expect(api.listBillableOrders).not.toHaveBeenCalled();

    api.listBillableOrders.mockRejectedValue(apiError(500));
    const out = await html(NewBillPage({ searchParams: search() }));
    expect(out).toContain('purchase orders did not load');
    expect(out).toContain('name="vendorPartyId"');
    expect(out).toContain('Upload invoice');
  });

  it('says a submission that is not in the inbox any more is gone', async () => {
    api.listBillSubmissions.mockResolvedValue([]);
    const out = await html(NewBillPage({ searchParams: search(SUB) }));
    expect(out).toContain('not waiting any more');
  });

  it('shows the header from the submission and one fixed row per order line, without a total', async () => {
    api.listBillSubmissions.mockResolvedValue([submission]);
    const out = await html(NewBillPage({ searchParams: search(SUB) }));
    expect(out).toContain('Himal Traders');
    expect(out).toContain('PO-2083-0007');
    expect(out).toContain('Still open on the order: 6 pcs');
    expect(out).toContain('VAT 13%');
    expect(out).not.toContain('Add a line');
    expect(out).not.toContain('Payable');
  });

  it('keeps the form away until the file has scanned clean', async () => {
    api.listBillSubmissions.mockResolvedValue([{ ...submission, fileStatus: 'scanning' }]);
    const out = await html(NewBillPage({ searchParams: search(SUB) }));
    expect(out).toContain('cannot be keyed in yet');
    expect(out).not.toContain('Create bill');
  });

  it('keeps a no-order bill open for several lines', async () => {
    api.listBillSubmissions.mockResolvedValue([{ ...submission, purchaseOrderId: null }]);
    const out = await html(NewBillPage({ searchParams: search(SUB) }));
    expect(out).toContain('Add a line');
  });

  it('blocks a person who cannot enter bills', async () => {
    session.roles = ['finance'];
    const out = await html(NewBillPage({ searchParams: search(SUB) }));
    expect(out).toContain('You cannot key in bills');
    expect(api.listBillSubmissions).not.toHaveBeenCalled();
  });

  // The PO page offers Enter bill from the API's live grants; the page it opens must agree (U18 #12).
  it("opens for Procurement after an admin granted payables.bill.enter, from the order's Enter bill link", async () => {
    session.roles = ['procurement'];
    grants.live = new Map([
      ['procurement.po.issue', 'all'],
      ['payables.bill.enter', 'all'],
    ]);
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ po: PO }) }));
    expect(out).not.toContain('You cannot key in bills');
    expect(api.getPoProgress).toHaveBeenCalledWith(expect.anything(), PO);
    expect(out).toContain(`name="purchaseOrderId" value="${PO}"`);
  });

  it('blocks an accountant whose payables.bill.enter an admin removed, before loading anything', async () => {
    grants.live = new Map([['payables.bill.read', 'all']]);
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ po: PO }) }));
    expect(out).toContain('You cannot key in bills');
    expect(api.getPoProgress).not.toHaveBeenCalled();
    expect(api.listBillableOrders).not.toHaveBeenCalled();
    expect(out).not.toContain('Himal Traders');
  });
});

const inbox = (sp: Record<string, string | string[]> = {}) =>
  html(InboxPage({ searchParams: Promise.resolve(sp) }));

describe('inbox', () => {
  it('lists submissions with their scan status and offers Create bill only on a clean one', async () => {
    api.listBillSubmissionsPage.mockResolvedValue(
      page([
        submission,
        {
          ...submission,
          id: BILL,
          vendorName: null,
          vendorInvoiceNo: null,
          fileStatus: 'scanning',
        },
      ]),
    );
    const out = await inbox();
    expect(out).toContain('Himal Traders');
    expect(out).toContain('Scanned clean');
    expect(out).toContain('Scanning');
    expect(out).toContain(`/payables/bills/new?submission=${SUB}`);
    expect(out).not.toContain(`/payables/bills/new?submission=${BILL}`);
    expect(out).toContain('Waiting for the file scan to pass');
    expect(out).toContain('Reject');
    // The table sits under the filters as on the other inboxes, with no card level of its own.
    expect(out).not.toContain('Waiting for a bill');
  });

  it('searches and pages by the server total, with no status filter', async () => {
    api.listBillSubmissionsPage.mockResolvedValue(page([submission], 61));
    const out = await inbox({ q: 'Himal', page: '2', status: 'received' });
    expect(api.listBillSubmissionsPage).toHaveBeenCalledWith(expect.anything(), {
      q: 'Himal',
      limit: 25,
      offset: 25,
    });
    expect(out).toContain('Showing 1 of 61 submissions');
    expect(out).toContain('Showing 26–50 of 61');
    expect(out).not.toContain('name="status"');
  });

  it('reads the rows-per-page choice from the URL', async () => {
    api.listBillSubmissionsPage.mockResolvedValue(page([submission], 61));
    await inbox({ rows: '10' });
    expect(api.listBillSubmissionsPage).toHaveBeenCalledWith(expect.anything(), {
      limit: 10,
      offset: 0,
    });
  });

  it('says when the inbox is empty or a search matches none, and shows a 403 as no access', async () => {
    api.listBillSubmissionsPage.mockResolvedValue(page([]));
    expect(await inbox()).toContain('The inbox is empty.');
    const none = await inbox({ q: 'zzz' });
    expect(none).toContain('No submissions match.');
    expect(none).toContain('Clear filters');
    api.listBillSubmissionsPage.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await inbox()).toContain('You cannot open the inbox');
  });
});

describe('bill-entry withholding registry', () => {
  it('loads named withholding codes on standalone entry', async () => {
    const out = await html(NewBillPage({ searchParams: Promise.resolve({}) }));
    expect(api.listWithholdingCodes).toHaveBeenCalledOnce();
    expect(out).toContain('TDS0');
    expect(out).toContain('Pending accountant signoff');
    // The dropdown submits the line's withholding code through a hidden field, empty by default,
    // and its trigger reads "No withholding".
    expect(out).toMatch(/<input type="hidden"[^>]*name="line:0:tdsCodeId"[^>]*value=""/);
    expect(out).toContain('No withholding');
  });
  it('blocks entry when the withholding lookup fails rather than dropping the selection', async () => {
    api.listWithholdingCodes.mockRejectedValue(apiError(500));
    const out = await html(NewBillPage({ searchParams: Promise.resolve({}) }));
    expect(out).toContain('The bill details did not load');
    expect(out).not.toContain('name="line:0:tdsCodeId"');
  });
});

describe('bill detail under the per-bill can flags', () => {
  // The panel text also says 'Match again', so look for the trigger button.
  const MATCH_BUTTON = /<button[^>]*>(<[^>]+>|\s)*Match again/;
  const open = () => html(BillPage({ params: Promise.resolve({ id: BILL }) }));
  const matching = { ...header, status: 'matching', matchStatus: 'matched', lines: [line] };
  const approved = { ...header, status: 'approved', matchStatus: 'matched', lines: [line] };
  const OTHERS = { match: false, submit: false, void: false, discard: false, exception: false };
  const OWN = { match: true, submit: true, void: true, discard: true, exception: true };

  it("hides Match, Submit and Void on another person's bill from someone whose grant is narrowed to own", async () => {
    // The live grant still holds payables.bill.enter (at `own`); only the API's can says this bill is not theirs.
    grants.live = new Map([
      ['payables.bill.read', 'all'],
      ['payables.bill.enter', 'own'],
    ]);
    api.getBill.mockResolvedValue({ ...matching, can: OTHERS });
    const others = await open();
    expect(others).toContain('BILL-2083-0001');
    expect(others).not.toMatch(MATCH_BUTTON);
    expect(others).not.toContain('Submit for approval');
    api.getBill.mockResolvedValue({ ...approved, can: OTHERS });
    expect(await open()).not.toContain('Void bill');

    api.getBill.mockResolvedValue({ ...matching, can: OWN });
    const own = await open();
    expect(own).toMatch(MATCH_BUTTON);
    expect(own).toContain('Submit for approval');
    api.getBill.mockResolvedValue({ ...approved, can: OWN });
    expect(await open()).toContain('Void bill');
  });

  it('keeps offering the actions by grant and status when the bill comes without can', async () => {
    api.getBill.mockResolvedValue(matching);
    const out = await open();
    expect(out).toMatch(MATCH_BUTTON);
    expect(out).toContain('Submit for approval');
    api.getBill.mockResolvedValue(approved);
    expect(await open()).toContain('Void bill');
  });
});

describe('expense accounts on bills', () => {
  const openBill = () => html(BillPage({ params: Promise.resolve({ id: BILL }) }));
  const draft = { ...header, status: 'draft', matchStatus: 'not_required', lines: [line] };
  const newBill = () => html(NewBillPage({ searchParams: Promise.resolve({}) }));

  it('names each line account by code and name, reading retired accounts too', async () => {
    api.getBill.mockResolvedValue(draft);
    const out = await openBill();
    expect(out).toContain('Expense account');
    expect(out).toContain('5100 · Office supplies');
    expect(api.listExpenseAccounts).toHaveBeenCalledWith(expect.anything(), {
      includeRetired: true,
    });
  });

  it('says Unknown account for a saved id with no match, never the id', async () => {
    api.getBill.mockResolvedValue(draft);
    api.listExpenseAccounts.mockResolvedValue([]);
    const out = await openBill();
    expect(out).toContain('Unknown account');
    expect(out).not.toContain(`>${VENDOR}<`);
  });

  it('keeps the bill on screen when the accounts do not load, saying so instead of guessing', async () => {
    api.getBill.mockResolvedValue(draft);
    api.listExpenseAccounts.mockRejectedValue(apiError(500));
    const out = await openBill();
    expect(out).toContain('BILL-2083-0001');
    expect(out).toContain('Not loaded');
    expect(out).toContain('The expense accounts did not load');
    expect(out).not.toContain('Unknown account');
  });

  it('loads every account for the pickers and labels the line field Expense account', async () => {
    const out = await newBill();
    expect(api.listExpenseAccounts).toHaveBeenCalledWith(expect.anything(), {
      includeRetired: true,
    });
    expect(out).toContain('Expense account');
    expect(out).toContain('The account this line is booked to.');
    expect(out).toMatch(/<input type="hidden" name="line:0:accountId" value=""/);
    expect(out).not.toContain('Account ID');
    expect(out).not.toContain('No expense accounts yet');
  });

  it('posts the ids of the active accounts only, so a refusal marks just the lines outside them', async () => {
    const RETIRED = '99999999-9999-4999-8999-999999999999';
    api.listExpenseAccounts.mockResolvedValue([
      OFFICE,
      {
        ...OFFICE,
        id: RETIRED,
        code: '5200',
        status: 'retired',
        retiredAt: '2026-11-01T00:00:00Z',
      },
    ]);
    const out = await newBill();
    expect(out).toContain(`<input type="hidden" name="activeAccountIds" value="${VENDOR}"/>`);
    expect(out).not.toContain(`value="${VENDOR},${RETIRED}"`);
  });

  it('shows a retry when the accounts fail to load, and a no-access note for a 403', async () => {
    api.listExpenseAccounts.mockRejectedValue(apiError(500));
    let out = await newBill();
    expect(out).toContain('The expense accounts did not load');
    expect(out).toContain('Try again');
    expect(out).not.toContain('name="line:0:accountId"');

    api.listExpenseAccounts.mockRejectedValue(apiError(403));
    out = await newBill();
    expect(out).toContain('cannot read this company&#x27;s expense accounts');
    expect(out).not.toContain('Try again');
  });

  it('blocks a submission bill while its accounts cannot be read', async () => {
    api.listBillSubmissions.mockResolvedValue([submission]);
    api.listExpenseAccounts.mockRejectedValue(apiError(500));
    const out = await html(NewBillPage({ searchParams: Promise.resolve({ submission: SUB }) }));
    expect(out).toContain('This bill cannot be keyed in yet');
    expect(out).not.toContain('name="line:0:accountId"');
  });

  it('names what to add when no account is active, linking to settings for finance', async () => {
    api.listExpenseAccounts.mockResolvedValue([
      { ...OFFICE, status: 'retired', retiredAt: '2026-11-01T00:00:00Z' },
    ]);
    const out = await newBill();
    expect(out).toContain('No expense accounts yet');
    expect(out).toContain('href="/settings/company-accounts"');
  });

  it('leaves the settings link out for someone who cannot open it', async () => {
    grants.live = new Map([['payables.bill.enter', 'all']]);
    api.listExpenseAccounts.mockResolvedValue([]);
    const out = await newBill();
    expect(out).toContain('No expense accounts yet');
    expect(out).toContain('Ask someone in Finance');
    expect(out).not.toContain('href="/settings/company-accounts"');
  });
});

describe('the vendor on a bill', () => {
  const open = () => html(BillPage({ params: Promise.resolve({ id: BILL }) }));

  it('links the vendor for someone who may read vendors, and names it as plain text otherwise', async () => {
    api.getBill.mockResolvedValue({ ...header, lines: [line] });
    grants.live = new Map([
      ['payables.bill.read', 'all'],
      ['vendor.read', 'all'],
    ]);
    const reader = await open();
    expect(reader).toContain(`href="/vendors/${VENDOR}"`);
    expect(reader).toContain('Himal Traders');

    grants.live = new Map([['payables.bill.read', 'all']]);
    const other = await open();
    expect(other).toContain('Himal Traders');
    expect(other).not.toContain(`/vendors/${VENDOR}`);
  });
});
