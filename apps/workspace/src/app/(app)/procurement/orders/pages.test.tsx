import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
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
  usePathname: () => '/procurement/orders',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  amendAction: vi.fn(),
  cancelAction: vi.fn(),
  cancelAndRecreateAction: vi.fn(),
  changeVendorAction: vi.fn(),
  issueAction: vi.fn(),
  shortCloseAction: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listPurchaseOrdersPage: vi.fn(),
  getPurchaseOrder: vi.fn(),
  listPoVersions: vi.fn(),
  getPoProgress: vi.fn(),
}));
vi.mock('@/lib/api-purchase-orders', () => api);
const vendors = vi.hoisted(() => ({ getVendor: vi.fn(), listVendors: vi.fn() }));
vi.mock('@/lib/api-vendors', () => vendors);

const { default: OrdersPage } = await import('./page');
const { default: OrderPage } = await import('./[id]/page');

const ID = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const VENDOR = '33333333-3333-4333-8333-333333333333';

// The real viewer, with the routes it was given written beside its trigger, so a test can see whether Retry is
// offered (the dialog only asks for it once opened).
// The real issue dialog, with the version it was given written beside it (its hidden field renders only once opened).
vi.mock('./_components/order-actions', async (importOriginal) => {
  const real = await importOriginal<typeof import('./_components/order-actions')>();
  return {
    ...real,
    IssueDialog: (props: Parameters<typeof real.IssueDialog>[0]) => (
      <span data-issue-version={props.version}>
        <real.IssueDialog {...props} />
      </span>
    ),
  };
});
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
  vendorName: 'Himal Traders Pvt. Ltd.',
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
const page = (items: unknown[], total = items.length) => ({ items, total });
const list = async (sp: Record<string, string | string[]> = {}) =>
  html(await OrdersPage({ searchParams: Promise.resolve(sp) }));
const detail = async (id = ID) => html(await OrderPage({ params: Promise.resolve({ id }) }));

beforeEach(() => {
  session.roles = ['procurement'];
  grants.live = undefined;
  for (const fn of [...Object.values(api), ...Object.values(vendors)]) fn.mockReset();
  api.listPoVersions.mockResolvedValue([version(1)]);
  api.getPoProgress.mockResolvedValue(progress);
  vendors.getVendor.mockResolvedValue({ id: VENDOR, legalName: 'Himal Traders Pvt. Ltd.' });
  vendors.listVendors.mockResolvedValue({ items: [], total: 0 });
});

describe('the purchase order list', () => {
  it('shows each order with its server-formatted total, lakh grouping and vendor name', async () => {
    api.listPurchaseOrdersPage.mockResolvedValue(page([order()]));
    const out = await list();
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toMatch(/12,34,567/);
    expect(out).toContain(`/procurement/orders/${ID}`);
    expect(api.listPurchaseOrdersPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      limit: 25,
      offset: 0,
    });
  });

  it('passes repeated statuses, the search and the page window, ignoring a junk status', async () => {
    api.listPurchaseOrdersPage.mockResolvedValue(page([]));
    await list({ status: ['issued', 'nonsense', 'draft'], q: 'Himal', page: '3', rows: '10' });
    expect(api.listPurchaseOrdersPage).toHaveBeenLastCalledWith(expect.anything(), {
      status: ['issued', 'draft'],
      q: 'Himal',
      limit: 10,
      offset: 20,
    });
  });

  it('shows the total beyond the old 500 cap, the range and no Apply button', async () => {
    api.listPurchaseOrdersPage.mockResolvedValue(page([order()], 640));
    const out = await list({ status: 'issued' });
    expect(out).toContain('Showing 1 of 640 purchase orders');
    expect(out).toContain('Showing 1–25 of 640');
    expect(out).toContain('aria-label="Rows per page"');
    expect(out).toContain('type="search"');
    expect(out).not.toContain('>Apply<');
  });

  it('says so when there are none, and names the filters that match none', async () => {
    api.listPurchaseOrdersPage.mockResolvedValue(page([]));
    expect(await list()).toContain('No purchase orders yet.');
    const out = await list({ status: 'cancelled', q: 'zzz' });
    expect(out).toContain('No purchase orders match.');
    expect(out).toContain('Status: Cancelled');
    expect(out).toContain('Clear filters');
  });

  it('names each vendor from the list response, with no vendor read per row', async () => {
    vendors.getVendor.mockRejectedValue(apiError(403));
    api.listPurchaseOrdersPage.mockResolvedValue(
      page([order(), order({ id: LINE, number: 'PO-2082-0002', vendorName: 'Everest Supplies' })]),
    );
    const out = await list();
    expect(out).toContain('Himal Traders Pvt. Ltd.');
    expect(out).toContain('Everest Supplies');
    expect(out).not.toContain('Vendor name unavailable');
    expect(vendors.getVendor).not.toHaveBeenCalled();
    api.getPurchaseOrder.mockResolvedValue(order());
    expect(await detail()).toContain('Himal Traders Pvt. Ltd.');
    expect(vendors.getVendor).not.toHaveBeenCalled();
  });

  it('counts the orders per card with one-row reads over the same scoped list', async () => {
    api.listPurchaseOrdersPage.mockImplementation(
      (_s: unknown, query: { status?: string[]; limit: number }) =>
        Promise.resolve(
          query.limit === 1
            ? page([], (query.status ?? []).length === 0 ? 12 : (query.status ?? []).length * 3)
            : page([order()], 12),
        ),
    );
    const out = await list();
    expect(out).toContain('aria-label="Purchase order summary"');
    expect(out).toMatch(/Total purchase orders<\/dt><dd[^>]*>12</);
    expect(out).toMatch(/Waiting for delivery<\/dt><dd[^>]*>6</);
    expect(api.listPurchaseOrdersPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['issued', 'partially_received'],
      limit: 1,
      offset: 0,
    });
  });

  it('leaves the cards out when a count fails, and keeps the table', async () => {
    api.listPurchaseOrdersPage.mockImplementation((_s: unknown, query: { limit: number }) =>
      query.limit === 1 ? Promise.reject(apiError(500)) : Promise.resolve(page([order()])),
    );
    const out = await list();
    expect(out).not.toContain('Purchase order summary');
    expect(out).toContain('PO-2082-0001');
  });

  it('leaves the cards out when the list itself fails, even though the counts loaded', async () => {
    api.listPurchaseOrdersPage.mockImplementation((_s: unknown, query: { limit: number }) =>
      query.limit === 1 ? Promise.resolve(page([], 3)) : Promise.reject(apiError(500)),
    );
    const out = await list();
    expect(out).toContain('Purchase orders did not load');
    expect(out).not.toContain('Purchase order summary');
  });

  it('ends each row with the status and a View link named after the order', async () => {
    api.listPurchaseOrdersPage.mockResolvedValue(
      page([order(), order({ id: LINE, number: 'PO-2082-0002' })]),
    );
    const out = await list();
    expect(out).toContain('>Action</th>');
    expect(out).toContain('aria-label="View PO-2082-0001"');
    expect(out).toContain('aria-label="View PO-2082-0002"');
    expect(out).toContain(`href="/procurement/orders/${LINE}"`);
  });

  it('shows the no-access pattern for a 403 and a retry for any other failure', async () => {
    api.listPurchaseOrdersPage.mockRejectedValue(
      apiError(403, 'forbidden', { reason: 'no_permission' }),
    );
    expect(await list()).toContain('Your roles do not include purchase orders');
    api.listPurchaseOrdersPage.mockRejectedValue(apiError(500));
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
    // Each version opens in the viewer (a dialog trigger), with Download beside it; the label is not "Download PDF".
    // Download is a button that fetches the file in the app (R4c2), so no link to the document route is in the page.
    expect(
      out.match(/<button[^>]*aria-haspopup="dialog"[^>]*>[^]*?View PDF<\/button>/g),
    ).toHaveLength(2);
    expect(out).toMatch(/<button[^>]*aria-label="Download of version 1"/);
    expect(out).toMatch(/<button[^>]*aria-label="Download of version 2"/);
    expect(out).not.toContain(`href="/procurement/orders/${ID}/versions/1/document"`);
    expect(out).toContain('of version 2');
    expect(out).not.toContain('Download PDF');
    expect(out).toContain('Total, version 2');
    expect(out).toContain('Still open');
    expect(out).toMatch(/>6</);
  });

  // R4c2 (TR-Q4): a version PDF whose render was given up offers Retry to who may issue, and to no one else.
  it('offers Retry on each version PDF to Procurement, who may issue', async () => {
    api.getPurchaseOrder.mockResolvedValue(order({ currentVersion: 2 }));
    api.listPoVersions.mockResolvedValue([version(1), version(2)]);
    const out = await detail();
    expect(out).toContain(`data-retry-url="/procurement/orders/${ID}/versions/1/document/retry"`);
    expect(out).toContain(`data-retry-url="/procurement/orders/${ID}/versions/2/document/retry"`);
  });

  it('offers no Retry on a version PDF when procurement.po.issue was removed', async () => {
    grants.live = new Map([['procurement.pr.read', 'all']]);
    api.getPurchaseOrder.mockResolvedValue(order({ currentVersion: 2 }));
    api.listPoVersions.mockResolvedValue([version(1), version(2)]);
    const out = await detail();
    expect(out).toContain('View PDF');
    expect(out).not.toContain('data-retry-url');
  });

  it('offers Issue on a draft only, with no versions yet', async () => {
    api.getPurchaseOrder.mockResolvedValue(
      order({ status: 'draft', issuedAt: null, currentVersion: 0 }),
    );
    api.listPoVersions.mockResolvedValue([]);
    const out = await detail();
    expect(out).toContain('Issue purchase order');
    // The row version the page read (3), not the document version (0): issue is refused if the order changed since.
    expect(out).toContain('data-issue-version="3"');
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

  // F1-Q40 a: only a draft changes vendor; an issued order with nothing received is cancelled and recreated.
  it('offers Change vendor on a draft, without Cancel and recreate, and asks for the approved vendors', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    vendors.listVendors.mockResolvedValue({
      items: [
        { id: VENDOR, legalName: 'Himal Traders Pvt. Ltd.', tradeName: null },
        { id: OTHER, legalName: 'Everest Supplies Pvt. Ltd.', tradeName: 'Everest' },
      ],
      total: 2,
    });
    api.getPurchaseOrder.mockResolvedValue(
      order({ status: 'draft', issuedAt: null, currentVersion: 0 }),
    );
    api.listPoVersions.mockResolvedValue([]);
    const out = await detail();
    expect(out).toContain('Change vendor');
    expect(out).not.toContain('Cancel and recreate');
    expect(out).not.toContain('Cancel this order and create a new one');
    expect(vendors.listVendors).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('offers Cancel and recreate on an issued order, with the reason a vendor cannot change, and no Change vendor', async () => {
    api.getPurchaseOrder.mockResolvedValue(order());
    const out = await detail();
    expect(out).toContain('Cancel and recreate');
    expect(out).toContain('Cancel this order and create a new one');
    expect(out).not.toContain('Change vendor');
    expect(vendors.listVendors).not.toHaveBeenCalled();
  });

  it.each([
    'partially_received',
    'fully_received',
    'short_closed',
    'cancelled',
    'closed',
    'amendment_pending',
  ])('offers neither Change vendor nor Cancel and recreate on a %s order', async (status) => {
    api.getPurchaseOrder.mockResolvedValue(order({ status }));
    const out = await detail();
    expect(out).not.toContain('Change vendor');
    expect(out).not.toContain('Cancel and recreate');
    expect(out).not.toContain('Cancel this order and create a new one');
  });

  it('offers neither to Procurement whose procurement.po.issue an admin removed', async () => {
    grants.live = new Map([['procurement.pr.read', 'all']]);
    api.getPurchaseOrder.mockResolvedValue(order({ status: 'draft', issuedAt: null }));
    expect(await detail()).not.toContain('Change vendor');
    api.getPurchaseOrder.mockResolvedValue(order());
    expect(await detail()).not.toContain('Cancel and recreate');
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

  // The live grants decide, not the role defaults: both cases fail on the old role-default gate.
  it('offers the order actions to a role an admin granted procurement.po.issue', async () => {
    session.roles = ['accountant'];
    grants.live = new Map([['procurement.po.issue', 'own']]);
    api.getPurchaseOrder.mockResolvedValue(order());
    const out = await detail();
    expect(out).toContain('Amend order');
    expect(out).toContain('Cancel order');
  });

  it('hides the order actions from Procurement whose procurement.po.issue an admin removed', async () => {
    grants.live = new Map([['procurement.pr.read', 'all']]);
    api.getPurchaseOrder.mockResolvedValue(order());
    const out = await detail();
    expect(out).toContain('PO-2082-0001');
    expect(out).not.toContain('Amend order');
    expect(out).not.toContain('Cancel order');
  });

  it('offers no order action to a role without procurement.po.issue', async () => {
    session.roles = ['warehouse'];
    api.getPurchaseOrder.mockResolvedValue(order({ can: { enterBill: false, receive: true } }));
    const out = await detail();
    expect(out).not.toContain('Amend order');
    expect(out).not.toContain('Cancel order');
    expect(out).toContain('Receive goods');
  });

  // F1-Q52: finance, the accountant and the warehouse open the order read-only. The order's own `can` flags decide
  // Receive goods and Enter bill; on the old page any viewer of a service order was offered Receive goods.
  it('shows finance a read-only order: no action button, and the vendor named without a link it cannot open', async () => {
    session.roles = ['finance'];
    api.getPurchaseOrder.mockResolvedValue(
      order({
        lines: [{ ...line, kind: 'service', requiresSerials: false }],
        can: { enterBill: false, receive: false },
      }),
    );
    const out = await detail();
    expect(out).toContain('PO-2082-0001');
    for (const label of [
      'Issue purchase order',
      'Amend order',
      'Short-close',
      'Cancel order',
      'Receive goods',
      'Enter bill',
    ]) {
      expect(out).not.toContain(label);
    }
    expect(out).not.toContain('/procurement/receipts/new');
    // Finance reads vendors, so the name links; the warehouse does not, so it is plain text.
    expect(out).toContain(`/vendors/${VENDOR}`);
    session.roles = ['warehouse'];
    const warehouse = await detail();
    expect(warehouse).toContain('Himal Traders Pvt. Ltd.');
    expect(warehouse).not.toContain(`/vendors/${VENDOR}`);
  });

  it('offers the accountant Enter bill from the read-only order, and nothing else', async () => {
    session.roles = ['accountant'];
    api.getPurchaseOrder.mockResolvedValue(order({ can: { enterBill: true, receive: false } }));
    const out = await detail();
    expect(out).toContain(`/payables/bills/new?po=${ID}`);
    for (const label of ['Amend order', 'Cancel order', 'Receive goods']) {
      expect(out).not.toContain(label);
    }
  });

  it('makes the next step the one primary button, and Receipts a secondary button', async () => {
    const classOf = (out: string, label: string) =>
      new RegExp(`<a[^>]*class="([^"]*)"[^>]*>${label}</a>`).exec(out)?.[1] ?? '';
    session.roles = ['warehouse'];
    api.getPurchaseOrder.mockResolvedValue(order({ can: { enterBill: true, receive: true } }));
    let out = await detail();
    expect(classOf(out, 'Receive goods')).toMatch(/primary/);
    expect(classOf(out, 'Enter bill')).toMatch(/secondary/);
    expect(classOf(out, 'Receipts')).toMatch(/secondary/);
    session.roles = ['accountant'];
    api.getPurchaseOrder.mockResolvedValue(order({ can: { enterBill: true, receive: false } }));
    out = await detail();
    expect(out).not.toContain('Receive goods');
    expect(classOf(out, 'Enter bill')).toMatch(/primary/);
    session.roles = ['procurement'];
    api.getPurchaseOrder.mockResolvedValue(order());
    out = await detail();
    expect(out).toContain('Amend order');
    expect(out).not.toMatch(/class="[^"]*primary[^"]*"[^>]*>(Amend order|Cancel order|Receipts)</);
  });

  it('names the approval band in words, never the raw value', async () => {
    api.getPurchaseOrder.mockResolvedValue(order({ approvedBand: 'management' }));
    const out = await detail();
    expect(out).toContain('>Management<');
    expect(out).toContain('>Base<');
    expect(out).not.toMatch(/>(management|base)</);
  });

  it('offers Enter bill only when the order says the caller may enter a bill on it', async () => {
    session.roles = ['accountant'];
    api.getPurchaseOrder.mockResolvedValue(order({ can: { enterBill: true, receive: false } }));
    const out = await detail();
    expect(out).toContain('Enter bill');
    expect(out).toContain(`/payables/bills/new?po=${ID}`);
    for (const can of [{ enterBill: false, receive: false }, undefined]) {
      api.getPurchaseOrder.mockResolvedValue(order({ can }));
      const without = await detail();
      expect(without).not.toContain('Enter bill');
      expect(without).not.toContain('/payables/bills/new');
    }
  });

  it('still shows the order when the versions and progress panels fail', async () => {
    api.getPurchaseOrder.mockResolvedValue(order());
    api.listPoVersions.mockRejectedValue(apiError(500));
    api.getPoProgress.mockRejectedValue(apiError(500));
    const out = await detail();
    expect(out).toContain('PO-2082-0001');
    expect(out).toContain('The versions did not load');
    expect(out).toContain('The receipt progress did not load');
    expect(out).toContain('Himal Traders Pvt. Ltd.');
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
