import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['finance'] as string[] }));
const api = vi.hoisted(() => ({
  listPaymentRequestsPage: vi.fn(),
  getPaymentRequest: vi.fn(),
  listPaymentRequestItems: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: () => Promise.resolve(session) }));
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
vi.mock('@/lib/api-payables', () => api);
const currencies = vi.hoisted(() => ({ loadEnabledCurrencies: vi.fn() }));
vi.mock('@/lib/enabled-currencies.server', () => currencies);
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/payables/payment-requests',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  createPaymentRequestAction: vi.fn(),
  submitPaymentRequestAction: vi.fn(),
  cancelPaymentRequestAction: vi.fn(),
}));

const { default: ListPage } = await import('./page');
const { default: DetailPage } = await import('./[id]/page');
const { default: NewPage } = await import('./new/page');
const id = '11111111-1111-4111-8111-111111111111';
const record = {
  id,
  number: 'PAY-2083-0001',
  vendorPartyId: id,
  paymentType: 'settlement',
  purchaseOrderId: null,
  currency: 'NPR',
  totalAmount: '111500.00',
  fromBankAccountId: id,
  vendorBankAccountId: id,
  bankLast4: '1234',
  status: 'draft',
  requestedBy: id,
  approvalRequestId: null,
  cancelReason: null,
  version: 1,
  lines: [{ id, lineNo: 1, openItemId: id, amount: '111500.00' }],
  vendorName: 'Himal Supplies',
  can: { readVendor: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['finance'];
  grants.live = undefined;
  currencies.loadEnabledCurrencies.mockResolvedValue(['NPR', 'INR', 'USD']);
  api.listPaymentRequestsPage.mockResolvedValue({ items: [record], total: 1 });
  api.getPaymentRequest.mockResolvedValue(record);
  api.listPaymentRequestItems.mockResolvedValue([
    {
      openItemId: id,
      vendorPartyId: id,
      vendorName: 'Himal Supplies',
      vendorBillId: id,
      billNumber: 'BILL-1',
      vendorInvoiceNo: 'INV-1',
      currency: 'NPR',
      openAmount: '100.00',
      claimedAmount: '10.00',
      availableAmount: '90.00',
    },
  ]);
});

it('lists the server total and links to new and detail screens', async () => {
  const html = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('PAY-2083-0001');
  expect(html).toContain('/payables/payment-requests/new');
  expect(html).toContain(`/payables/payment-requests/${id}`);
  expect(html).toMatch(/does not send money|No money/i);
});

it('hides drafts actions from an approved request and shows its bank snapshot and approval', async () => {
  api.getPaymentRequest.mockResolvedValue({ ...record, status: 'approved', approvalRequestId: id });
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('1234');
  expect(html).toContain(`/inbox/${id}`);
  expect(html).not.toContain('Cancel draft');
  expect(html).not.toContain('Submit for approval');
});

it('offers submit and cancel only for a draft', async () => {
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('Submit for approval');
  expect(html).toContain('Cancel draft');
});

it('shows controlled entry fields for the vendor, source account and bill items', async () => {
  const html = renderToStaticMarkup(await NewPage());
  expect(html).toContain('name="vendorPartyId"');
  expect(html).toContain('name="fromBankAccountId"');
  expect(html).toContain('name="allocation:0:openItemId"');
  expect(html).toContain('name="allocation:0:amount"');
  expect(html).toContain('Himal Supplies');
  expect(html).not.toContain('Vendor ID');
  // The entry form gets the enabled currencies (D44), read once on the server.
  expect(currencies.loadEnabledCurrencies).toHaveBeenCalledOnce();
});

it('shows an empty state when all approved bill balances are claimed', async () => {
  api.listPaymentRequestItems.mockResolvedValue([]);
  const html = renderToStaticMarkup(await NewPage());
  expect(html).toContain('No approved bill balances');
  expect(html).not.toContain('Create draft request');
});

it('denies entry before loading eligible items and handles lookup failure', async () => {
  session.roles = ['accountant'];
  expect(renderToStaticMarkup(await NewPage())).toContain('Your roles');
  expect(api.listPaymentRequestItems).not.toHaveBeenCalled();
  session.roles = ['finance'];
  api.listPaymentRequestItems.mockRejectedValue(new Error('offline'));
  expect(renderToStaticMarkup(await NewPage())).toContain('Reload this page');
});

it('denies other roles without loading payment data', async () => {
  session.roles = ['accountant'];
  const html = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
  expect(html).toMatch(/roles/i);
  expect(api.listPaymentRequestsPage).not.toHaveBeenCalled();
});

it('never sends a malformed detail id upstream', async () => {
  await expect(DetailPage({ params: Promise.resolve({ id: '../x' }) })).rejects.toThrow(
    'NOT_FOUND',
  );
  expect(api.getPaymentRequest).not.toHaveBeenCalled();
});

it('resolves each bill reference and links to permitted bills', async () => {
  const other = '22222222-2222-4222-8222-222222222222';
  api.getPaymentRequest.mockResolvedValue({
    ...record,
    lines: [record.lines[0], { id: other, lineNo: 2, openItemId: other, amount: '20.00' }],
  });
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('BILL-1');
  expect(html).toContain('INV-1');
  expect(html).toContain(`/payables/bills/${id}`);
  expect(html).toContain('Bill 2 of 2');
});

it('keeps distinct non-ID bill labels when the reference lookup fails', async () => {
  api.listPaymentRequestItems.mockRejectedValue(new Error('offline'));
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('Bill 1 of 1');
  expect(html).not.toContain('Bill reference unavailable');
});

const listOf = async (sp: Record<string, string | string[]> = {}) =>
  renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve(sp) }));

it('sends repeated statuses, the search and the page window, and ignores a junk status', async () => {
  await listOf({ status: ['draft', 'nope', 'approved'], q: 'Himal', page: '3' });
  expect(api.listPaymentRequestsPage).toHaveBeenCalledWith(expect.anything(), {
    status: ['draft', 'approved'],
    q: 'Himal',
    limit: 25,
    offset: 50,
  });
});

it('shows the server total and range, with no Show button', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({ items: [record], total: 61 });
  const html = await listOf();
  expect(html).toContain('Showing 1 of 61 payment requests');
  expect(html).toContain('Showing 1-25 of 61');
  expect(html).toContain('type="search"');
  expect(html).not.toContain('Show requests');
});

it('says so when there are none, and names the filters that match none', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({ items: [], total: 0 });
  expect(await listOf()).toContain('No payment requests yet.');
  const html = await listOf({ status: 'rejected', q: 'zzz' });
  expect(html).toContain('No payment requests match.');
  expect(html).toContain('Clear filters');
});
