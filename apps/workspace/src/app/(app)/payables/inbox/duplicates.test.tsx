// I-33: the bill inbox shows the amount the vendor claimed and flags a submission whose vendor and invoice number
// are already on another bill or submission; the convert form names the earlier one and its amount. A warning,
// not a block. Drives the real API client through a stubbed fetch.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubApi, textOf } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'tok', roles: ['accountant'] }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/payables/inbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions', () => ({
  matchBillAction: vi.fn(),
  submitBillAction: vi.fn(),
  voidBillAction: vi.fn(),
  rejectSubmissionAction: vi.fn(),
  createBillAction: vi.fn(),
  convertSubmissionAction: vi.fn(),
  requestExceptionAction: vi.fn(),
  discardBillAction: vi.fn(),
}));

const { default: InboxPage } = await import('./page');
const { default: NewBillPage } = await import('../bills/new/page');

const SUB = '11111111-1111-4111-8111-111111111111';
const EARLIER = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
const VENDOR = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';

const submission = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  vendorPartyId: VENDOR,
  vendorName: 'Dev Vendor Co',
  purchaseOrderId: null,
  vendorInvoiceNo: 'INV-0042',
  invoiceDate: '2026-11-05',
  documentId: DOC,
  fileStatus: 'clean',
  note: null,
  status: 'received',
  receivedAt: '2026-11-18T05:45:00.000Z',
  claimedTotal: '112999.00',
  currency: 'NPR',
  duplicates: [],
  ...over,
});
const earlierBill = {
  kind: 'bill',
  id: BILL,
  number: 'BILL-2083/84-00005',
  vendorInvoiceNo: 'INV-0042',
  status: 'approved',
  amount: '113000.00',
  currency: 'NPR',
  at: '2026-11-10T05:45:00.000Z',
};
const earlierSubmission = {
  kind: 'submission',
  id: EARLIER,
  number: null,
  vendorInvoiceNo: 'inv 0042',
  status: 'received',
  amount: '100.00',
  currency: 'NPR',
  at: '2026-11-17T05:45:00.000Z',
};

let rows: unknown[] = [submission()];
beforeEach(() => {
  stubApi(() => ({ '/v1/payables/bill-submissions': rows }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const inbox = async () =>
  textOf(renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) })));
const convert = async () =>
  textOf(
    renderToStaticMarkup(await NewBillPage({ searchParams: Promise.resolve({ submission: SUB }) })),
  );

describe('bill inbox duplicates and amounts (I-33)', () => {
  it("shows the vendor's claimed amount in the row", async () => {
    rows = [submission()];
    const text = await inbox();
    expect(text).toContain('1,12,999.00');
    expect(text).not.toContain('Duplicate invoice number');
  });

  it('flags a row whose invoice number is already on another bill or submission', async () => {
    rows = [submission({ duplicates: [earlierBill] })];
    expect(await inbox()).toContain('Duplicate invoice number');
  });

  it('names the earlier bill and submission with their amounts on the convert form', async () => {
    rows = [submission({ duplicates: [earlierBill, earlierSubmission] })];
    const text = await convert();
    expect(text).toContain('Duplicate invoice number');
    expect(text).toContain('Bill BILL-2083/84-00005');
    expect(text).toContain('1,13,000.00');
    expect(text).toContain('Submission received');
    expect(text).toContain('100.00');
    expect(text).toContain('1,12,999.00');
  });

  it('shows no warning on the convert form when there is no duplicate', async () => {
    rows = [submission()];
    expect(await convert()).not.toContain('Duplicate invoice number');
  });
});
