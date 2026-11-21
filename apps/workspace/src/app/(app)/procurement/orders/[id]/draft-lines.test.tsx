// I-32: a draft PO from an approved commitment has no lines until issue copies them from the approved quotation.
// Its page shows those lines (sent as `proposedLines`) instead of saying it has none beside an enabled Issue
// button. Drives the real API client through a stubbed fetch.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubApi, textOf } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'tok', roles: ['procurement'] }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions', () => ({
  amendAction: vi.fn(),
  cancelAction: vi.fn(),
  cancelAndRecreateAction: vi.fn(),
  changeVendorAction: vi.fn(),
  issueAction: vi.fn(),
  shortCloseAction: vi.fn(),
}));

const { default: OrderPage } = await import('./page');

const PO = '11111111-1111-4111-8111-111111111111';
const QLINE = '22222222-2222-4222-8222-222222222222';
const PR = '33333333-3333-4333-8333-333333333333';
const PR_LINE = '44444444-4444-4444-8444-444444444444';
const VENDOR = '55555555-5555-4555-8555-555555555555';
const TAX = '66666666-6666-4666-8666-666666666666';

const line = {
  id: QLINE,
  lineNo: 1,
  prLineId: PR_LINE,
  kind: 'goods',
  description: 'Laptop 14 inch',
  uom: 'pcs',
  orderedQuantity: '1.0000',
  cancelledQuantity: '0.0000',
  unitPrice: '100000.00',
  taxCodeId: TAX,
  gross: '100000.00',
  taxAmount: '13000.00',
  lineTotal: '113000.00',
  requiresSerials: false,
};
const draft = (over: Record<string, unknown> = {}) => ({
  id: PO,
  number: 'PO-2083/84-00007',
  status: 'draft',
  purchaseRequestId: PR,
  rfqId: null,
  vendorQuotationId: null,
  vendorId: VENDOR,
  currency: 'NPR',
  paymentTermsDays: 0,
  advancePercent: '0.0000',
  approvedTotal: '113000.00',
  fxRate: '1.000000',
  approvedTotalNpr: '113000.00',
  approvedBand: 'management',
  currentVersion: 0,
  issuedAt: null,
  closedReason: null,
  version: 1,
  vendorName: 'Dev Vendor Co',
  lines: [],
  ...over,
});

let answer: Record<string, unknown> = draft();
beforeEach(() => {
  stubApi(() => ({
    [`/v1/procurement/purchase-orders/${PO}`]: answer,
    [`/v1/procurement/purchase-orders/${PO}/versions`]: [],
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const render = async () =>
  textOf(renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ id: PO }) })));

describe('draft purchase order lines (I-32)', () => {
  it('shows the approved quotation lines a draft will be issued with, and does not say it has none', async () => {
    answer = draft({ proposedLines: [line] });
    const text = await render();
    expect(text).toContain('Laptop 14 inch');
    expect(text).toContain('written to the order when it is issued');
    expect(text).not.toContain('This order has no lines');
    expect(text).not.toContain('needs at least one line');
  });

  it('does not contradict the Issue action when a draft has no lines from anywhere', async () => {
    answer = draft();
    const text = await render();
    expect(text).toContain('This order has no lines.');
    expect(text).toContain('copied in when the order is issued');
    expect(text).not.toContain('needs at least one line before it can be issued');
  });
});
