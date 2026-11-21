// R4f Q1 b: an approver opens the order they approve, read-only, without an order grant. The API answers the order
// itself but refuses its versions and receipt progress (403 with no grant, 404 for a grant that does not reach the
// order): the page leaves those parts out with no error text and no write controls. Drives the real API client
// through a stubbed fetch.
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { forbidden, json, meAs, stubApiEnv, textOf } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'tok', roles: ['management'] }),
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
  issueAction: vi.fn(),
  shortCloseAction: vi.fn(),
}));

const { default: OrderPage } = await import('./page');

const PO = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const PR = '33333333-3333-4333-8333-333333333333';
const PR_LINE = '44444444-4444-4444-8444-444444444444';
const VENDOR = '55555555-5555-4555-8555-555555555555';
const TAX = '66666666-6666-4666-8666-666666666666';

const order = {
  id: PO,
  number: 'PO-2083/84-00009',
  status: 'fully_received',
  purchaseRequestId: PR,
  rfqId: null,
  vendorQuotationId: null,
  vendorId: VENDOR,
  currency: 'NPR',
  paymentTermsDays: 30,
  advancePercent: '0.0000',
  approvedTotal: '565.00',
  fxRate: '1.000000',
  approvedTotalNpr: '565.00',
  approvedBand: 'management',
  currentVersion: 1,
  issuedAt: '2026-11-20T09:00:00.000Z',
  closedReason: null,
  version: 3,
  vendorName: 'Dev Vendor Co',
  lines: [
    {
      id: LINE,
      lineNo: 1,
      prLineId: PR_LINE,
      kind: 'goods',
      description: 'Generator fuel',
      uom: 'ltr',
      orderedQuantity: '5.0000',
      cancelledQuantity: '0.0000',
      unitPrice: '100.00',
      taxCodeId: TAX,
      gross: '500.00',
      taxAmount: '65.00',
      lineTotal: '565.00',
      requiresSerials: false,
    },
  ],
  can: { enterBill: false, receive: false },
};

const BASE = `/v1/procurement/purchase-orders/${PO}`;

/** Answers the order and the management user's grants; `rest` answers the versions and the receipt progress. */
function stub(rest: () => Response) {
  stubApiEnv();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      const path = new URL(input as URL | string).pathname;
      if (path === BASE) return Promise.resolve(json(200, order));
      if (path === '/v1/me') return Promise.resolve(json(200, meAs('management')));
      if (path === `${BASE}/versions` || path === `${BASE}/progress`) {
        return Promise.resolve(rest());
      }
      return Promise.resolve(forbidden());
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const render = async () =>
  textOf(renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ id: PO }) })));

/** What the page keeps for the approver: the order's details and lines, and no write control. */
function expectReadOnlyOrder(text: string) {
  expect(text).toContain('PO-2083/84-00009');
  expect(text).toContain('Order details');
  expect(text).toContain('Generator fuel');
  for (const control of [
    'Amend order',
    'Short-close',
    'Cancel order',
    'Issue purchase order',
    'Enter bill',
    'Receive goods',
  ]) {
    expect(text).not.toContain(control);
  }
}

describe('an approver reads the order they approve (R4f Q1 b)', () => {
  it('leaves out the versions, the PDFs and the receipt progress the API refuses (403), with no error text', async () => {
    stub(forbidden);
    const text = await render();
    expectReadOnlyOrder(text);
    expect(text).not.toContain('Versions');
    expect(text).not.toContain('Receipts');
    expect(text).not.toContain('View PDF');
    expect(text).not.toContain('Still open');
    expect(text).not.toContain('Your roles do not include');
    expect(text).not.toContain('did not load');
    expect(text).not.toContain('Ask an administrator');
  });

  it('does the same for a grant that does not reach the order (404)', async () => {
    stub(() =>
      json(404, { error: { code: 'not_found', message: 'Not found', correlationId: 'c' } }),
    );
    const text = await render();
    expectReadOnlyOrder(text);
    expect(text).not.toContain('Versions');
    expect(text).not.toContain('Receipts');
    expect(text).not.toContain('View PDF');
    expect(text).not.toContain('did not load');
  });

  it('still says so when those parts fail for another reason', async () => {
    stub(() => json(500, { error: { code: 'internal', message: 'Boom', correlationId: 'c' } }));
    const text = await render();
    expect(text).toContain('The versions did not load');
    expect(text).toContain('The receipt progress did not load');
  });
});
