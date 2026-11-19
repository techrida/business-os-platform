import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

import {
  amendPurchaseOrder,
  cancelPurchaseOrder,
  confirmReceipt,
  discardReceipt,
  createReceipt,
  getPoProgress,
  getPurchaseOrder,
  issuePoDocumentLink,
  issuePurchaseOrder,
  listPoVersions,
  listPurchaseOrders,
  listPurchaseOrdersPage,
  listReceipts,
  listReceivableOrders,
  PurchaseOrderSchema,
  reverseReceipt,
  shortClosePurchaseOrder,
} from './api-purchase-orders';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const PO = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const VENDOR = '33333333-3333-4333-8333-333333333333';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: PO,
  orgKind: 'staff',
  roles: ['procurement'],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};

const line = {
  id: LINE,
  lineNo: 1,
  prLineId: null,
  kind: 'goods',
  description: 'Laptop',
  uom: 'pcs',
  orderedQuantity: '10.0000',
  cancelledQuantity: '0.0000',
  unitPrice: '1000.00',
  taxCodeId: VENDOR,
  gross: '10000.00',
  taxAmount: '1300.00',
  lineTotal: '11300.00',
  requiresSerials: true,
};
const { lines: _lines, ...listFields } = {
  id: PO,
  number: 'PO-2082-0001',
  status: 'issued',
  purchaseRequestId: VENDOR,
  rfqId: null,
  vendorQuotationId: null,
  vendorId: VENDOR,
  vendorName: 'Himal Traders',
  currency: 'NPR',
  paymentTermsDays: 30,
  advancePercent: '0.00',
  approvedTotal: '11300.00',
  fxRate: '1.000000',
  approvedTotalNpr: '11300.00',
  approvedBand: 'base',
  currentVersion: 1,
  issuedAt: '2026-11-08T05:45:00.000Z',
  closedReason: null,
  version: 3,
  lines: [line],
};
const order = { ...listFields, lines: [line] };
const progress = {
  purchaseOrderId: PO,
  vendorId: VENDOR,
  vendorName: 'Himal Traders',
  number: 'PO-2082-0001',
  status: 'issued',
  lines: [
    {
      poLineId: LINE,
      lineNo: 1,
      kind: 'goods',
      description: 'Laptop',
      uom: 'pcs',
      requiresSerials: true,
      orderedQuantity: '10.0000',
      cancelledQuantity: '0.0000',
      receivedQuantity: '0.0000',
      pendingQuantity: '0.0000',
      openQuantity: '10.0000',
      billedQuantity: '0.0000',
    },
  ],
};
const receipt = {
  id: RECEIPT,
  number: 'GRN-2082-0001',
  purchaseOrderId: PO,
  kind: 'goods',
  receivedAt: '2026-11-09',
  location: null,
  status: 'draft',
  createdBy: VENDOR,
  confirmedBy: null,
  confirmedAt: null,
  reversesReceiptId: null,
  reversalReason: null,
  version: 1,
  createdAt: '2026-11-09T05:45:00.000Z',
  lines: [
    {
      id: VENDOR,
      lineNo: 1,
      poLineId: LINE,
      quantity: '2.0000',
      reversesReceiptLineId: null,
      inspection: null,
      discrepancyNote: null,
      overReceiptExceptionId: null,
      serials: [{ serialNo: 'SN-1', batchNo: null, warrantyUntil: null }],
    },
  ],
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const answer = (r: Response): void => {
  fetchMock.mockImplementation(() => Promise.resolve(r.clone()));
};
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
  const requestInit = init ?? {};
  const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
  return { url: href, init: requestInit, headers: new Headers(requestInit.headers) };
}

beforeEach(() => {
  vi.stubEnv('API_INTERNAL_URL', 'http://api:3001');
  for (const [k, v] of Object.entries({
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('purchase order reads', () => {
  it('lists with only the status the API accepts (its query is strict)', async () => {
    answer(reply([listFields]));
    const out = await listPurchaseOrders(session, 'issued');
    expect(out[0]?.number).toBe('PO-2082-0001');
    expect(lastCall().url).toBe('http://api:3001/v1/procurement/purchase-orders?status=issued');
    expect(lastCall().headers.get('authorization')).toBe('Bearer eyJ.secret-access-token.sig');
    answer(reply([]));
    await listPurchaseOrders(session);
    expect(lastCall().url).toBe('http://api:3001/v1/procurement/purchase-orders');
  });

  it('lists a page with repeated statuses, a search and an offset, and reads the total', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([listFields]), {
          status: 200,
          headers: { 'x-total-count': '640' },
        }),
      ),
    );
    const out = await listPurchaseOrdersPage(session, {
      status: ['issued', 'draft'],
      q: 'Himal',
      limit: 25,
      offset: 50,
    });
    expect(out.total).toBe(640);
    expect(out.items[0]?.number).toBe('PO-2082-0001');
    expect(lastCall().url).toBe(
      'http://api:3001/v1/procurement/purchase-orders?status=issued&status=draft&q=Himal&limit=25&offset=50',
    );
    answer(reply([listFields]));
    expect((await listPurchaseOrdersPage(session, { limit: 25, offset: 0 })).total).toBe(1);
  });

  it('keeps money as the server sent it, never a number', async () => {
    answer(reply(order));
    const out = await getPurchaseOrder(session, PO);
    expect(out.approvedTotal).toBe('11300.00');
    expect(typeof out.lines[0]?.lineTotal).toBe('string');
  });

  it('reads versions and progress, and encodes the id', async () => {
    answer(
      reply([
        {
          id: LINE,
          version: 1,
          reason: null,
          total: '11300.00',
          totalNpr: '11300.00',
          band: 'base',
          approvalRequestId: null,
          createdBy: VENDOR,
          createdAt: '2026-11-08T05:45:00.000Z',
          snapshot: { anything: true },
        },
      ]),
    );
    expect((await listPoVersions(session, PO))[0]?.totalNpr).toBe('11300.00');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/purchase-orders/${PO}/versions`);
    answer(reply(progress));
    expect((await getPoProgress(session, PO)).lines[0]?.openQuantity).toBe('10.0000');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/purchase-orders/${PO}/progress`);
    answer(reply(order));
    await getPurchaseOrder(session, '../x');
    expect(lastCall().url).toContain('/purchase-orders/..%2Fx');
  });

  it('turns a body that breaks the contract into a 502', async () => {
    answer(reply({ ...order, status: 'sideways' }));
    await expect(getPurchaseOrder(session, PO)).rejects.toMatchObject({ status: 502 });
  });

  it('carries the API refusal with its status and body', async () => {
    answer(reply({ error: { code: 'not_found' } }, 404));
    const err = await getPurchaseOrder(session, PO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe('purchase order writes always send the Idempotency-Key', () => {
  it('issue posts the key and no body', async () => {
    answer(reply(order));
    await issuePurchaseOrder(session, PO, KEY);
    const { url, init, headers } = lastCall();
    expect(url).toBe(`http://api:3001/v1/procurement/purchase-orders/${PO}/issue`);
    expect(init.method).toBe('POST');
    expect(headers.get('idempotency-key')).toBe(KEY);
  });

  it('amend, short-close and cancel send their body and the key', async () => {
    answer(reply({ outcome: 'pending_approval', approvalRequestId: LINE, purchaseOrder: order }));
    const out = await amendPurchaseOrder(
      session,
      PO,
      { reason: 'Price rise', lines: [{ poLineId: LINE, quantity: '12' }] },
      KEY,
    );
    expect(out.outcome).toBe('pending_approval');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      reason: 'Price rise',
      lines: [{ poLineId: LINE, quantity: '12' }],
    });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);

    answer(reply(order));
    await shortClosePurchaseOrder(session, PO, 'Vendor cannot supply', KEY);
    expect(lastCall().url).toContain('/short-close');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ reason: 'Vendor cannot supply' });
    await cancelPurchaseOrder(session, PO, 'Ordered twice', KEY);
    expect(lastCall().url).toContain('/cancel');
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
  });

  it('refuses an amend answer with an outcome it does not know', async () => {
    answer(reply({ outcome: 'maybe', approvalRequestId: null, purchaseOrder: order }));
    await expect(
      amendPurchaseOrder(session, PO, { reason: 'x', lines: [{ poLineId: LINE }] }, KEY),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('purchase order PDF link', () => {
  it('asks for one version by number', async () => {
    answer(reply({ url: '/v1/files/abc.def', expiresAt: '2026-11-08T05:46:00.000Z' }));
    const link = await issuePoDocumentLink(session, PO, 2);
    expect(link.url).toBe('/v1/files/abc.def');
    expect(lastCall().url).toBe(
      `http://api:3001/v1/procurement/purchase-orders/${PO}/versions/2/document`,
    );
  });
});

const receivable = {
  id: PO,
  number: 'PO-2082-0001',
  vendorId: VENDOR,
  vendorName: 'Himal Traders Pvt. Ltd.',
  kind: 'mixed',
  status: 'partially_received',
  issuedAt: '2026-11-08T05:45:00.000Z',
  openQuantity: '9.0000',
};

describe('receivable orders', () => {
  it('lists with the default limit left to the API, and with an explicit one (strict query)', async () => {
    answer(reply([receivable]));
    const out = await listReceivableOrders(session);
    expect(out[0]).toEqual(receivable);
    expect(lastCall().url).toBe('http://api:3001/v1/procurement/receivable-orders');
    await listReceivableOrders(session, 25);
    expect(lastCall().url).toBe('http://api:3001/v1/procurement/receivable-orders?limit=25');
  });

  it('accepts an order without an issue date, and keeps the quantity as text', async () => {
    const { issuedAt: _issuedAt, ...bare } = receivable;
    answer(reply([bare]));
    const out = await listReceivableOrders(session);
    expect(out[0]?.issuedAt).toBeUndefined();
    expect(out[0]?.openQuantity).toBe('9.0000');
  });

  it('turns a status or kind the DTO does not have, or an extra field, into a 502', async () => {
    for (const bad of [
      { ...receivable, status: 'closed' },
      { ...receivable, kind: 'other' },
      { ...receivable, openQuantity: 9 },
      { ...receivable, surprise: true },
    ]) {
      answer(reply([bad]));
      await expect(listReceivableOrders(session)).rejects.toMatchObject({ status: 502 });
    }
  });

  it('carries a 403 with its status', async () => {
    answer(reply({ error: { code: 'forbidden' } }, 403));
    await expect(listReceivableOrders(session)).rejects.toMatchObject({ status: 403 });
  });
});

describe('receipts', () => {
  it('discards a draft with the idempotency key and parses the terminal status', async () => {
    answer(reply({ ...receipt, status: 'discarded' }));
    expect((await discardReceipt(session, RECEIPT, KEY)).status).toBe('discarded');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/receipts/${RECEIPT}/discard`);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    expect(lastCall().init.body).toBeUndefined();
  });
  it('lists the receipts of one purchase order and nothing else (strict query)', async () => {
    answer(reply([receipt]));
    const out = await listReceipts(session, PO);
    expect(out[0]?.number).toBe('GRN-2082-0001');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/receipts?purchaseOrderId=${PO}`);
  });

  it('create posts the body with the key; confirm and reverse too', async () => {
    answer(reply(receipt, 201));
    await createReceipt(
      session,
      {
        purchaseOrderId: PO,
        kind: 'goods',
        receivedAt: '2026-11-09',
        lines: [{ poLineId: LINE, quantity: '2', serials: [{ serialNo: 'SN-1' }] }],
      },
      KEY,
    );
    expect(lastCall().url).toBe('http://api:3001/v1/procurement/receipts');
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    const sent = JSON.parse(lastCall().init.body as string) as {
      lines: { serials: unknown }[];
    };
    expect(sent.lines[0]?.serials).toEqual([{ serialNo: 'SN-1' }]);

    answer(reply({ ...receipt, status: 'confirmed' }));
    expect((await confirmReceipt(session, RECEIPT, KEY)).status).toBe('confirmed');
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/receipts/${RECEIPT}/confirm`);
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);

    answer(reply({ ...receipt, status: 'confirmed', reversesReceiptId: RECEIPT }));
    await reverseReceipt(session, RECEIPT, 'Wrong goods', KEY);
    expect(lastCall().url).toBe(`http://api:3001/v1/procurement/receipts/${RECEIPT}/reverse`);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ reason: 'Wrong goods' });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
  });
});

it('validates purchase order advances at four-place precision and accepts older values', () => {
  for (const advancePercent of ['25.00', '33.3334', '100.0000']) {
    const parsed = PurchaseOrderSchema.parse({ ...order, advancePercent });
    expect(parsed.advancePercent).toBe(advancePercent);
  }
  for (const advancePercent of ['33.33334', '100.0001', '-0.1']) {
    expect(PurchaseOrderSchema.safeParse({ ...order, advancePercent }).success).toBe(false);
  }
});
