// I-31: the approval page names the vendor and the order a bill or commitment snapshot refers to by id, from the
// `references` the API sends with the request. Drives the real API client through a stubbed fetch.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubApi, textOf } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'tok', roles: ['finance'] }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { default: InboxDetailPage } = await import('./page');

const RID = '11111111-1111-4111-8111-111111111111';
const BILL = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const VENDOR = '66666666-6666-4666-8666-666666666666';
const PO = '77777777-7777-4777-8777-777777777777';
const WHEN = '2026-11-18T05:45:00.000Z';

const billRequest = (over: Record<string, unknown> = {}) => ({
  requestId: RID,
  documentType: 'vendor_bill',
  documentId: BILL,
  documentNumber: 'BILL-2083/84-00005',
  status: 'pending',
  blockReason: null,
  currentSeq: 1,
  version: 1,
  requesterUserId: REQUESTER,
  snapshot: {
    number: 'BILL-2083/84-00005',
    vendorPartyId: VENDOR,
    vendorInvoiceNo: 'INV-77',
    purchaseOrderId: PO,
    matchStatus: 'matched',
    netTotal: '100000.00',
    vatTotal: '13000.00',
  },
  steps: [],
  actions: [],
  submittedAt: WHEN,
  decidedAt: null,
  people: [{ userId: REQUESTER, name: 'Dev Accountant' }],
  ...over,
});

let answer: Record<string, unknown> = billRequest();
beforeEach(() => {
  stubApi(() => ({ [`/v1/approvals/requests/${RID}`]: answer, '/v1/approvals/inbox': [] }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const render = async () =>
  textOf(renderToStaticMarkup(await InboxDetailPage({ params: Promise.resolve({ id: RID }) })));

describe('approval snapshot references (I-31)', () => {
  it('names the vendor and the purchase order of a bill from the references sent with the request', async () => {
    answer = billRequest({
      references: [
        { id: VENDOR, name: 'Dev Vendor Co' },
        { id: PO, name: 'PO-2083/84-00007' },
      ],
    });
    const text = await render();
    expect(text).toContain('Dev Vendor Co');
    expect(text).toContain('PO-2083/84-00007');
    expect(text).not.toContain('Name unavailable');
  });

  it('names the recommended vendor inside a commitment snapshot', async () => {
    answer = billRequest({
      documentType: 'pr_commitment',
      snapshot: { commitment: { rfqNumber: 'RFQ-2083/84-00009', vendorId: VENDOR, total: '1.00' } },
      references: [{ id: VENDOR, name: 'Dev Vendor Co' }],
    });
    const text = await render();
    expect(text).toContain('Dev Vendor Co');
    expect(text).not.toContain('Name unavailable');
  });

  it('still says the name is unavailable for an id the API did not name', async () => {
    answer = billRequest({ references: [{ id: VENDOR, name: 'Dev Vendor Co' }] });
    const text = await render();
    expect(text).toContain('Dev Vendor Co');
    expect(text).toContain('Name unavailable');
  });
});
