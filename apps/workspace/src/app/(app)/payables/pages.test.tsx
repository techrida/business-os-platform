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
  listWithholdingCodes: vi.fn(),
  listVendors: vi.fn(),
  listBillableOrders: vi.fn(),
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
}));
vi.mock('@/lib/api-purchase-orders', () => ({ getPoProgress: api.getPoProgress }));
vi.mock('@/lib/api-vendors', () => ({ getVendor: api.getVendor, listVendors: api.listVendors }));
vi.mock('@/lib/api-tax-codes', () => ({ listTaxCodes: api.listTaxCodes }));
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
  for (const fn of Object.values(api)) fn.mockReset();
  api.getVendor.mockResolvedValue({ legalName: 'Himal Traders' });
  api.getPoProgress.mockResolvedValue(progress);
  api.listTaxCodes.mockResolvedValue([{ id: VENDOR, label: 'VAT 13%' }]);
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
    expect(out).toContain('Showing 1-25 of 240');
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

  it('shows Finance the order number sent with the bill, with no purchase order read of its own', async () => {
    session.roles = ['finance'];
    api.getBill.mockResolvedValue({ ...header, status: 'pending_approval', lines: [line] });
    api.getPoProgress.mockRejectedValue(apiError(403, 'forbidden'));
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('PO-2083-0007');
    expect(out).not.toContain('An order');
    expect(out).not.toContain(`/procurement/orders/${PO}`);
    expect(api.getPoProgress).not.toHaveBeenCalled();
  });

  it('still shows the bill when the vendor and the order cannot be read', async () => {
    api.getBill.mockResolvedValue({ ...header, lines: [line] });
    api.getVendor.mockRejectedValue(apiError(403));
    api.getPoProgress.mockRejectedValue(apiError(500));
    const out = await html(BillPage({ params: Promise.resolve({ id: BILL }) }));
    expect(out).toContain('Himal Traders');
    expect(out).toContain('INV-001');
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
    expect(out).toContain('Showing 26-50 of 61');
    expect(out).not.toContain('name="status"');
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
