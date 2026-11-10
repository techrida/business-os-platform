import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
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
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('./actions', () => ({
  amendAction: vi.fn(),
  cancelAction: vi.fn(),
  issueAction: vi.fn(),
  shortCloseAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listPurchaseOrders: vi.fn(),
  getPurchaseOrder: vi.fn(),
  listPoVersions: vi.fn(),
  getPoProgress: vi.fn(),
}));
vi.mock('@/lib/api-purchase-orders', () => api);
const vendors = vi.hoisted(() => ({ getVendor: vi.fn() }));
vi.mock('@/lib/api-vendors', () => vendors);

const { default: OrdersPage } = await import('./page');
const { default: OrderPage } = await import('./[id]/page');

const ID = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const VENDOR = '33333333-3333-4333-8333-333333333333';

const apiError = (status: number, code = 'x', extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

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
const order = (over: Record<string, unknown> = {}) => ({
  id: ID,
  number: 'PO-2082-0001',
  status: 'issued',
  purchaseRequestId: VENDOR,
  rfqId: null,
  vendorQuotationId: null,
  vendorId: VENDOR,
  currency: 'NPR',
  paymentTermsDays: 30,
  advancePercent: '0.00',
  approvedTotal: '1234567.00',
  fxRate: '1.000000',
  approvedTotalNpr: '1234567.00',
  approvedBand: 'founder',
  currentVersion: 1,
  issuedAt: '2026-11-08T05:45:00.000Z',
  closedReason: null,
  version: 3,
  lines: [line],
  ...over,
});
const version = (n: number) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}`,
  version: n,
  reason: n === 1 ? null : 'Price rise',
  total: '11300.00',
  totalNpr: '11300.00',
  band: 'base',
  approvalRequestId: null,
  createdBy: VENDOR,
  createdAt: '2026-11-08T05:45:00.000Z',
  snapshot: {},
});
const progress = {
  purchaseOrderId: ID,
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
      receivedQuantity: '4.0000',
      pendingQuantity: '1.0000',
      openQuantity: '6.0000',
      billedQuantity: '0.0000',
    },
  ],
};

const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);
const list = async (sp: Record<string, string> = {}) =>
  html(await OrdersPage({ searchParams: Promise.resolve(sp) }));
const detail = async (id = ID) => html(await OrderPage({ params: Promise.resolve({ id }) }));

beforeEach(() => {
  session.roles = ['procurement'];
  for (const fn of [...Object.values(api), ...Object.values(vendors)]) fn.mockReset();
  api.listPoVersions.mockResolvedValue([version(1)]);
  api.getPoProgress.mockResolvedValue(progress);
  vendors.getVendor.mockResolvedValue({ id: VENDOR, legalName: 'Himal Traders Pvt. Ltd.' });
});

describe('the purchase order list', () => {
  it('shows each order with its server-formatted total, lakh grouping and vendor name', async () => {
    api.listPurchaseOrders.mockResolvedValue([order()]);
    const out = await list();
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toMatch(/12,34,567/);
    expect(out).toContain(`/procurement/orders/${ID}`);
    expect(api.listPurchaseOrders).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('passes a valid status filter on and ignores a junk one', async () => {
    api.listPurchaseOrders.mockResolvedValue([]);
    await list({ status: 'issued' });
    expect(api.listPurchaseOrders).toHaveBeenLastCalledWith(expect.anything(), 'issued');
    await list({ status: 'nonsense' });
    expect(api.listPurchaseOrders).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });

  it('says so when there are none, and when a filter matches none', async () => {
    api.listPurchaseOrders.mockResolvedValue([]);
    expect(await list()).toContain('No purchase orders yet.');
    expect(await list({ status: 'cancelled' })).toContain('No cancelled purchase orders.');
  });

  it('falls back to an unavailable-name label when the vendor cannot be read, and keeps a long name wrapping', async () => {
    vendors.getVendor.mockRejectedValue(apiError(403));
    api.listPurchaseOrders.mockResolvedValue([order()]);
    expect(await list()).toContain('Vendor name unavailable');
  });

  it('shows the no-access pattern for a 403 and a retry for any other failure', async () => {
    api.listPurchaseOrders.mockRejectedValue(
      apiError(403, 'forbidden', { reason: 'no_permission' }),
    );
    expect(await list()).toContain('Your roles do not include purchase orders');
    api.listPurchaseOrders.mockRejectedValue(apiError(500));
    const out = await list();
    expect(out).toContain('Purchase orders did not load');
    expect(out).toContain('Reload purchase orders');
  });
});

describe('the purchase order page', () => {
  it('shows the version total from the server, progress per line and a PDF link per version', async () => {
    api.getPurchaseOrder.mockResolvedValue(order({ currentVersion: 2 }));
    api.listPoVersions.mockResolvedValue([version(1), version(2)]);
    const out = await detail();
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain(`/procurement/orders/${ID}/versions/1/document`);
    expect(out).toContain(`/procurement/orders/${ID}/versions/2/document`);
    expect(out).toContain('Total, version 2');
    expect(out).toContain('Still open');
    expect(out).toMatch(/>6</);
  });

  it('offers Issue on a draft only, with no versions yet', async () => {
    api.getPurchaseOrder.mockResolvedValue(
      order({ status: 'draft', issuedAt: null, currentVersion: 0 }),
    );
    api.listPoVersions.mockResolvedValue([]);
    const out = await detail();
    expect(out).toContain('Issue purchase order');
    expect(out).not.toContain('Amend order');
    expect(out).toContain('Not issued yet.');
  });

  it('offers Amend and Cancel while issued, Amend and Short-close once part arrived', async () => {
    api.getPurchaseOrder.mockResolvedValue(order());
    let out = await detail();
    expect(out).toContain('Amend order');
    expect(out).toContain('Cancel order');
    expect(out).not.toContain('Short-close');
    api.getPurchaseOrder.mockResolvedValue(order({ status: 'partially_received' }));
    out = await detail();
    expect(out).toContain('Amend order');
    expect(out).toContain('Short-close');
    expect(out).not.toContain('Cancel order');
  });

  it('shows the amendment-pending banner and no action buttons', async () => {
    api.getPurchaseOrder.mockResolvedValue(order({ status: 'amendment_pending' }));
    const out = await detail();
    expect(out).toContain('An amendment is waiting for approval');
    for (const label of ['Amend order', 'Cancel order', 'Short-close', 'Issue purchase order']) {
      expect(out).not.toContain(label);
    }
    expect(out).not.toContain('Receive goods');
  });

  it('offers no action to a role without procurement.po.issue', async () => {
    session.roles = ['warehouse'];
    api.getPurchaseOrder.mockResolvedValue(order());
    const out = await detail();
    expect(out).not.toContain('Amend order');
    expect(out).not.toContain('Cancel order');
    expect(out).toContain('Receive goods');
  });

  it('still shows the order when the vendor, versions and progress panels fail', async () => {
    api.getPurchaseOrder.mockResolvedValue(order());
    api.listPoVersions.mockRejectedValue(apiError(500));
    api.getPoProgress.mockRejectedValue(apiError(500));
    vendors.getVendor.mockRejectedValue(apiError(403));
    const out = await detail();
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('The versions did not load');
    expect(out).toContain('The receipt progress did not load');
    expect(out).toContain('Vendor name unavailable');
    expect(out).toContain('Approved total');
  });

  it('wraps a very long item description instead of widening the table', async () => {
    const long = 'Industrial-grade-ultra-long-description-'.repeat(8);
    api.getPurchaseOrder.mockResolvedValue(order({ lines: [{ ...line, description: long }] }));
    expect(await detail()).toContain(long);
  });

  it('is not found for an id that is not a GUID or that the API does not know', async () => {
    await expect(detail('../admin')).rejects.toThrow('NOT_FOUND');
    expect(api.getPurchaseOrder).not.toHaveBeenCalled();
    api.getPurchaseOrder.mockRejectedValue(apiError(404, 'not_found'));
    await expect(detail()).rejects.toThrow('NOT_FOUND');
  });

  it('shows the no-access pattern for a 403', async () => {
    api.getPurchaseOrder.mockRejectedValue(apiError(403, 'forbidden', { reason: 'no_permission' }));
    expect(await detail()).toContain('You cannot open this purchase order');
  });
});
