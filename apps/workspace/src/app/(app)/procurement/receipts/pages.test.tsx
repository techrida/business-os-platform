import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['warehouse'] as string[] }));
const me = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  getMe: me.getMe,
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: session.roles, accessToken: 'tok' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('./actions', () => ({
  createReceiptAction: vi.fn(),
  confirmReceiptAction: vi.fn(),
  reverseReceiptAction: vi.fn(),
  discardReceiptAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listReceivableOrders: vi.fn(),
  listRequestedOrders: vi.fn(),
  listReceipts: vi.fn(),
  getReceipt: vi.fn(),
  getPoProgress: vi.fn(),
}));
vi.mock('@/lib/api-purchase-orders', () => api);

const { default: ReceiptsPage } = await import('./page');
const { default: NewReceiptPage } = await import('./new/page');
const { default: ReceiptPage } = await import('./[id]/page');

const PO = '11111111-1111-4111-8111-111111111111';
const SERIAL = '22222222-2222-4222-8222-222222222221';
const SERVICE = '22222222-2222-4222-8222-222222222223';
const RECEIPT = '33333333-3333-4333-8333-333333333333';
const REVERSAL = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

const apiError = (status: number, code = 'x', extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

const progressLine = (over: Record<string, unknown>) => ({
  poLineId: SERIAL,
  lineNo: 1,
  kind: 'goods',
  description: 'Laptop',
  uom: 'pcs',
  requiresSerials: true,
  orderedQuantity: '10.0000',
  cancelledQuantity: '0.0000',
  receivedQuantity: '3.0000',
  pendingQuantity: '1.0000',
  openQuantity: '6.0000', // cap 5
  billedQuantity: '0.0000',
  ...over,
});
const progress = (over: Record<string, unknown> = {}, lines = [progressLine({})]) => ({
  purchaseOrderId: PO,
  number: 'PO-2082-0001',
  status: 'partially_received',
  lines,
  ...over,
});

const receipt = (over: Record<string, unknown> = {}) => ({
  id: RECEIPT,
  number: 'GRN-2082/83-00001',
  purchaseOrderId: PO,
  kind: 'goods',
  receivedAt: '2026-11-08',
  location: 'Main store',
  status: 'draft',
  createdBy: USER,
  confirmedBy: null,
  confirmedAt: null,
  reversesReceiptId: null,
  reversalReason: null,
  version: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
  lines: [
    {
      id: '66666666-6666-4666-8666-666666666666',
      lineNo: 1,
      poLineId: SERIAL,
      quantity: '2.0000',
      reversesReceiptLineId: null,
      inspection: 'Boxes sealed',
      discrepancyNote: null,
      overReceiptExceptionId: null,
      serials: [
        { serialNo: 'SN-0001', batchNo: null, warrantyUntil: null },
        { serialNo: 'SN-0002', batchNo: null, warrantyUntil: null },
      ],
    },
  ],
  ...over,
});

const waiting = (over: Record<string, unknown> = {}) => ({
  id: PO,
  number: 'PO-2082-0001',
  vendorId: USER,
  vendorName: 'Himal Traders Pvt. Ltd.',
  kind: 'mixed',
  status: 'partially_received',
  issuedAt: '2026-11-08T20:30:00.000Z', // 9 Nov, 02:15 in Kathmandu
  openQuantity: '9.0000',
  ...over,
});

const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);
const list = async (sp: Record<string, string> = { po: PO }) =>
  html(await ReceiptsPage({ searchParams: Promise.resolve(sp) }));
const newPage = async (sp: Record<string, string> = { po: PO }) =>
  html(await NewReceiptPage({ searchParams: Promise.resolve(sp) }));
const detail = async (id = RECEIPT, sp: Record<string, string> = {}) =>
  html(await ReceiptPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  session.roles = ['warehouse'];
  me.getMe.mockReset().mockRejectedValue(new Error('offline'));
  for (const fn of Object.values(api)) fn.mockReset();
  api.listReceivableOrders.mockResolvedValue([waiting()]);
  api.listRequestedOrders.mockResolvedValue([]);
  api.getPoProgress.mockResolvedValue(progress());
  api.listReceipts.mockResolvedValue([receipt()]);
  api.getReceipt.mockResolvedValue(receipt());
});

describe('the receipts of one purchase order', () => {
  it('says there is no order to open for a person with none, asks for no raw ID and lists no receipts', async () => {
    session.roles = ['operations_officer'];
    const out = await list({});
    expect(out).toContain('No purchase orders to open');
    expect(out).not.toContain('Purchase order ID');
    expect(out).not.toContain('name="po"');
    expect(out).not.toContain('/procurement/orders');
    expect(api.listReceipts).not.toHaveBeenCalled();
    expect(api.listReceivableOrders).not.toHaveBeenCalled();
  });

  it('says a link that names no order names none, and offers the order list to procurement only', async () => {
    session.roles = ['operations_officer'];
    const out = await list({ po: '../admin' });
    expect(out).toContain('That link does not name a purchase order');
    expect(api.listReceipts).not.toHaveBeenCalled();
    session.roles = ['procurement'];
    const proc = await list({});
    expect(proc).toContain('href="/procurement/orders"');
    expect(proc).not.toContain('No purchase orders to open');
    expect(api.listReceivableOrders).not.toHaveBeenCalled();
  });

  it('offers the requester the orders of their own purchase requests, each opening its receipts', async () => {
    session.roles = ['operations_officer'];
    api.listRequestedOrders.mockResolvedValue([
      { id: SERVICE, number: 'PO-2082-0002', status: 'issued', vendorName: 'Everest Cleaners' },
    ]);
    const out = await list({});
    expect(api.listRequestedOrders).toHaveBeenCalledTimes(1);
    expect(out).toContain('Your purchase orders');
    expect(out).toContain('PO-2082-0002');
    expect(out).toContain('Everest Cleaners');
    expect(out).toContain('Issued');
    expect(out).toContain(`href="/procurement/receipts?po=${SERVICE}"`);
    expect(out).not.toContain('Purchase order ID');
    expect(out).not.toContain('No purchase orders to open');
    expect(api.listReceivableOrders).not.toHaveBeenCalled();
    expect(api.listReceipts).not.toHaveBeenCalled();
  });

  it("leaves the requester's list out on a 403 and words any other failure", async () => {
    session.roles = ['operations_officer'];
    api.listRequestedOrders.mockRejectedValue(apiError(403, 'forbidden'));
    let out = await list({});
    expect(out).not.toContain('Your purchase orders');
    expect(out).not.toContain('role="alert"');
    api.listRequestedOrders.mockRejectedValue(apiError(500));
    out = await list({});
    expect(out).toContain('Your purchase orders did not load');
    expect(out).not.toContain('internal wording');
    expect(out).not.toContain('No purchase orders to open');
  });

  it('lists the orders waiting to be received for the warehouse, each row linking to its receipts', async () => {
    api.listReceivableOrders.mockResolvedValue([
      waiting(),
      waiting({
        id: SERVICE,
        number: 'PO-2082-0002',
        vendorName: 'Everest Cleaners',
        kind: 'service',
        status: 'issued',
        issuedAt: undefined,
        openQuantity: '12.5000',
      }),
    ]);
    const out = await list({});
    expect(api.listReceivableOrders).toHaveBeenCalledTimes(1);
    expect(api.listReceipts).not.toHaveBeenCalled();
    expect(out).toContain('Waiting to be received');
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('Partly received');
    expect(out).toContain('9 Nov 2026');
    expect(out).toContain('>9<');
    expect(out).toContain('>12.5<');
    expect(out).toContain('Everest Cleaners');
    expect(out).toContain('>Service<');
    expect(out).toContain('>Mixed<');
    expect(out).toContain('Not recorded');
    expect(out).toContain(`href="/procurement/receipts?po=${PO}"`);
    expect(out).toContain(`href="/procurement/receipts/new?po=${PO}"`);
    expect(out).toContain(`href="/procurement/receipts/new?po=${SERVICE}"`);
    expect(out).toContain('aria-label="New receipt for PO-2082-0001"');
    expect(out).not.toContain('Purchase order ID');
  });

  it('says no purchase order is waiting', async () => {
    api.listReceivableOrders.mockResolvedValue([]);
    const out = await list({});
    expect(out).toContain('No purchase orders are waiting to be received');
    expect(out).not.toContain('Purchase order ID');
  });

  it('leaves the waiting list out when it is forbidden', async () => {
    api.listReceivableOrders.mockRejectedValue(apiError(403, 'forbidden'));
    const out = await list({});
    expect(out).not.toContain('Waiting to be received');
    expect(out).not.toContain('role="alert"');
    expect(out).toContain('No purchase orders to open');
  });

  it('shows an error alert on a failed list', async () => {
    api.listReceivableOrders.mockRejectedValue(apiError(500));
    const out = await list({});
    expect(out).toContain('role="alert"');
    expect(out).toContain('The waiting orders did not load');
    expect(out).not.toContain('internal wording');
    expect(out).not.toContain('No purchase orders to open');
  });

  it('keeps the invalid-link alert above the list for the warehouse', async () => {
    const out = await list({ po: '../admin' });
    expect(out).toContain('That link does not name a purchase order');
    expect(out).toContain('Waiting to be received');
    expect(api.listReceipts).not.toHaveBeenCalled();
  });

  it('shows each receipt with its kind, status, date and a link, and the order progress', async () => {
    api.listReceipts.mockResolvedValue([
      receipt({ id: REVERSAL, number: 'GRN-2', status: 'confirmed', reversesReceiptId: RECEIPT }),
      receipt({ status: 'reversed' }),
    ]);
    const out = await list();
    expect(api.listReceipts).toHaveBeenCalledWith(expect.anything(), PO);
    expect(out).toContain('GRN-2082/83-00001');
    expect(out).toContain(`/procurement/receipts/${RECEIPT}`);
    expect(out).toContain('Goods receipt');
    expect(out).toContain('Reversed');
    expect(out).toContain('Reversal of GRN-2082/83-00001');
    expect(out).toContain('Where the order stands');
    expect(out).toContain('Waiting in drafts');
    expect(out).toContain(`/procurement/receipts/new?po=${PO}`);
  });

  it('says nothing has been received yet, with a way to start', async () => {
    api.listReceipts.mockResolvedValue([]);
    const out = await list();
    expect(out).toContain('Nothing has been received yet.');
    expect(out).toContain('New receipt');
  });

  it('hides New receipt where the order takes none or nothing is left, but still lists receipts', async () => {
    api.getPoProgress.mockResolvedValue(progress({ status: 'closed' }));
    expect(await list()).not.toContain('New receipt');
    api.getPoProgress.mockResolvedValue(
      progress({}, [progressLine({ pendingQuantity: '6.0000' })]),
    );
    expect(await list()).not.toContain('New receipt');
    expect(await list()).toContain('GRN-2082/83-00001');
  });

  it('keeps the list when only the progress fails', async () => {
    api.getPoProgress.mockRejectedValue(apiError(500));
    const out = await list();
    expect(out).toContain('GRN-2082/83-00001');
    expect(out).toContain('The order&#x27;s progress did not load');
    api.getPoProgress.mockRejectedValue(apiError(403));
    expect(await list()).toContain('Your roles do not include the order');
  });

  it('words a 403 and a 500 of the list, and shows not-found for another entity', async () => {
    api.listReceipts.mockRejectedValue(apiError(403, 'forbidden'));
    const forbidden = await list();
    expect(forbidden).toContain('You cannot open these receipts');
    expect(forbidden).not.toContain('internal wording');
    api.listReceipts.mockRejectedValue(apiError(500));
    const broken = await list();
    expect(broken).toContain('The receipts did not load');
    expect(broken).toContain('Try again');
    api.listReceipts.mockRejectedValue(apiError(404, 'not_found'));
    await expect(list()).rejects.toThrow('NOT_FOUND');
  });
});

describe('the new receipt form', () => {
  it('sends a missing or bad purchase order back to the choice', async () => {
    await expect(newPage({})).rejects.toThrow('redirect /procurement/receipts');
    await expect(newPage({ po: 'nope' })).rejects.toThrow('redirect /procurement/receipts');
    expect(api.getPoProgress).not.toHaveBeenCalled();
  });

  it('is built from the progress: the cap is open minus pending, and today is the default date', async () => {
    const out = await newPage();
    expect(api.getPoProgress).toHaveBeenCalledWith(expect.anything(), PO);
    expect(out).toContain('Up to 5 pcs can be received now.');
    expect(out).toContain('1 waiting in draft receipts');
    expect(out).toMatch(/type="date"[^>]*value="\d{4}-\d{2}-\d{2}"/);
    expect(out).toContain('Serial numbers');
    expect(out).toContain('Save draft receipt');
    expect(out).toContain(`name="purchaseOrderId" value="${PO}"`);
    expect(out).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
    expect(api.getReceipt).not.toHaveBeenCalled();
  });

  it('lays each line out as a table row, with the same field names and a per-line name per input', async () => {
    const out = await newPage();
    expect(out).toMatch(/aria-hidden="true"[^>]*><span>#<\/span>/);
    expect(out).toContain('<span>Quantity received</span>');
    expect(out.match(/<li class="[^"]*line[^"]*"/g)).toHaveLength(1);
    for (const name of ['qty', 'inspection', 'note', 'serials']) {
      expect(out).toContain(`name="${name}:${SERIAL}"`);
    }
    expect(out).toContain('Inspection<span class="sr-only"> (line 1)</span>');
    expect(out).toContain('Serial numbers<span class="sr-only"> (line 1)</span>');
  });

  it('offers a choice of kind when the person may receive both', async () => {
    api.getPoProgress.mockResolvedValue(
      progress({}, [
        progressLine({}),
        progressLine({
          poLineId: SERVICE,
          lineNo: 2,
          kind: 'service',
          description: 'Installation',
          uom: 'visit',
          requiresSerials: false,
          receivedQuantity: '0.0000',
          pendingQuantity: '0.0000',
          openQuantity: '2.0000',
        }),
      ]),
    );
    const out = await newPage();
    expect(out).toContain('What is being received');
    expect(out).toContain('type="radio"');
    session.roles = ['procurement'];
    const serviceOnly = await newPage();
    expect(serviceOnly).not.toContain('type="radio"');
    expect(serviceOnly).toContain('name="kind" value="service"');
    expect(serviceOnly).not.toContain('Laptop');
  });

  it('refuses goods to a person without the warehouse grant, without showing a form', async () => {
    session.roles = ['procurement'];
    const out = await newPage();
    expect(out).toContain('Your roles do not include receiving goods');
    expect(out).not.toContain('Save draft receipt');
  });

  it('says so when the order takes no receipts or nothing is left', async () => {
    api.getPoProgress.mockResolvedValue(progress({ status: 'amendment_pending' }));
    expect(await newPage()).toContain('takes no new receipts');
    api.getPoProgress.mockResolvedValue(progress({}, [progressLine({ openQuantity: '1.0000' })]));
    const none = await newPage();
    expect(none).toContain('Nothing is left to receive.');
    expect(none).not.toContain('Save draft receipt');
  });

  it('words a missing order, a 403 and a failed load', async () => {
    api.getPoProgress.mockRejectedValue(apiError(404, 'not_found'));
    await expect(newPage()).rejects.toThrow('NOT_FOUND');
    api.getPoProgress.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await newPage()).toContain('You cannot receive on this order');
    api.getPoProgress.mockRejectedValue(apiError(503));
    expect(await newPage()).toContain('The order did not load');
  });
});

describe('one receipt', () => {
  it('offers discard on an authorized draft even if the PO no longer takes confirmation', async () => {
    api.getPoProgress.mockResolvedValue(progress({ status: 'short_closed' }));
    expect(await detail()).toContain('Discard draft');
    session.roles = ['procurement'];
    expect(await detail()).not.toContain('Discard draft');
    session.roles = ['warehouse'];
    api.getReceipt.mockResolvedValue(receipt({ status: 'discarded' }));
    const out = await detail();
    expect(out).toContain('Discarded');
    expect(out).not.toContain('Discard draft');
  });
  it('shows a goods draft to the warehouse with Confirm and no Reverse, and its serials', async () => {
    const out = await detail();
    expect(out).toContain('GRN-2082/83-00001');
    expect(out).toContain('Confirm receipt');
    expect(out).not.toContain('Reverse receipt');
    expect(out).toContain('2 serial numbers');
    expect(out).toContain('SN-0001');
    expect(out).toContain('Laptop');
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('Boxes sealed');
  });

  it('keeps Confirm from a person who cannot receive goods, and says who can', async () => {
    session.roles = ['procurement'];
    const out = await detail();
    expect(out).not.toContain('Confirm receipt');
    expect(out).toContain('Confirming goods is for the warehouse');
  });

  it('shows Confirm to anyone for a service draft', async () => {
    session.roles = ['sales'];
    api.getReceipt.mockResolvedValue(receipt({ kind: 'service' }));
    const out = await detail();
    expect(out).toContain('Confirm receipt');
    expect(out).toContain('Service confirmation');
    expect(out).not.toContain('Confirming goods is for the warehouse');
  });

  it('shows Reverse, with a reason dialog, on a confirmed receipt and no Confirm', async () => {
    api.getReceipt.mockResolvedValue(
      receipt({ status: 'confirmed', confirmedAt: '2026-11-08T06:00:00.000Z', confirmedBy: USER }),
    );
    const out = await detail();
    expect(out).toContain('Reverse receipt');
    expect(out).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Reverse receipt<\/button>/);
    expect(out).not.toContain('Confirm receipt');
  });

  it('hides Reverse on a reversal, shows negative quantities and links the original', async () => {
    api.getReceipt.mockResolvedValue(
      receipt({
        id: REVERSAL,
        number: 'GRN-2',
        status: 'confirmed',
        reversesReceiptId: RECEIPT,
        reversalReason: 'Wrong delivery',
        lines: [{ ...receipt().lines[0], quantity: '-2.0000', serials: [] }],
      }),
    );
    api.listReceipts.mockResolvedValue([receipt({ status: 'reversed' })]);
    const out = await detail(REVERSAL);
    expect(out).not.toContain('Reverse receipt');
    expect(out).toContain('-2 pcs');
    expect(out).toContain('Wrong delivery');
    expect(out).toContain(`/procurement/receipts/${RECEIPT}`);
    expect(out).toContain('GRN-2082/83-00001');
  });

  it('says a reversed receipt was reversed, and by which receipt, with no buttons', async () => {
    api.getReceipt.mockResolvedValue(receipt({ status: 'reversed' }));
    api.listReceipts.mockResolvedValue([
      receipt({
        id: REVERSAL,
        number: 'GRN-2',
        status: 'confirmed',
        reversesReceiptId: RECEIPT,
        reversalReason: 'Wrong delivery',
      }),
    ]);
    const out = await detail();
    expect(out).toContain('This receipt was reversed');
    expect(out).toContain(`/procurement/receipts/${REVERSAL}`);
    expect(out).toContain('Wrong delivery');
    expect(out).not.toContain('Reverse receipt');
    expect(out).not.toContain('Confirm receipt');
  });

  it('warns that a draft on a closed order cannot be confirmed, and hides Confirm', async () => {
    api.getPoProgress.mockResolvedValue(progress({ status: 'short_closed' }));
    const out = await detail();
    expect(out).toContain('This draft cannot be confirmed now');
    expect(out).not.toContain('Confirm receipt');
  });

  it('explains when a draft affects the purchase order', async () => {
    expect(await detail(RECEIPT, { created: '1' })).toContain(
      'This draft counts as received on the purchase order once it is confirmed.',
    );
    expect(await detail()).not.toContain('The draft receipt was saved');
  });

  it('still shows the receipt when the order details fail, and links the PO by role', async () => {
    api.getPoProgress.mockRejectedValue(apiError(500));
    const out = await detail();
    expect(out).toContain('GRN-2082/83-00001');
    expect(out).toContain('Purchase order line');
    expect(out).toContain('The order&#x27;s details did not load');
    expect(out).toContain(`href="/procurement/receipts?po=${PO}"`);
    session.roles = ['procurement'];
    expect(await detail()).toContain(`href="/procurement/orders/${PO}"`);
  });

  it('shows not-found for a bad id or another entity, and words a 403 and a 500', async () => {
    await expect(detail('../x')).rejects.toThrow('NOT_FOUND');
    expect(api.getReceipt).not.toHaveBeenCalled();
    api.getReceipt.mockRejectedValue(apiError(404, 'not_found'));
    await expect(detail()).rejects.toThrow('NOT_FOUND');
    api.getReceipt.mockRejectedValue(apiError(403, 'forbidden'));
    expect(await detail()).toContain('You cannot open this receipt');
    api.getReceipt.mockRejectedValue(apiError(500));
    const broken = await detail();
    expect(broken).toContain('This receipt did not load');
    expect(broken).toContain('Try again');
  });

  it('respects live permissions and hides Confirm receipt when procurement.receipt.confirm is revoked', async () => {
    session.roles = ['warehouse'];
    me.getMe.mockResolvedValue({
      permissions: [{ permission: 'procurement.receipt.read', scope: 'all' }],
    });
    const out = await detail();
    expect(out).not.toContain('Confirm receipt');
    expect(out).not.toContain('Discard draft');
  });
});
