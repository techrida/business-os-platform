import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['finance'] as string[] }));
const api = vi.hoisted(() => ({
  listPaymentRequestsPage: vi.fn(),
  getPaymentRequest: vi.fn(),
  listPaymentRequestItems: vi.fn(),
  listPaymentRequestItemsWithoutBankAccount: vi.fn(),
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
const banks = vi.hoisted(() => ({ listCompanyBankAccounts: vi.fn() }));
vi.mock('@/lib/api-company-accounts', () => banks);
const bankAccount = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Operating account',
  bankName: 'Nabil Bank',
  last4: '1234',
  currency: 'NPR',
  status: 'active',
  retiredAt: null,
};
const reads = vi.hoisted(() => ({ getVendor: vi.fn(), getApprovalRequest: vi.fn() }));
vi.mock('@/lib/api-vendors', () => ({ getVendor: reads.getVendor }));
vi.mock('@/lib/api-kernel', async (original) => ({
  ...(await original<typeof import('@/lib/api-kernel')>()),
  getApprovalRequest: reads.getApprovalRequest,
}));
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
  api.listPaymentRequestsPage.mockResolvedValue({ items: [record], total: 1, totals: null });
  reads.getVendor.mockResolvedValue({ legalName: 'Himal Supplies' });
  reads.getApprovalRequest.mockRejectedValue(new Error('forbidden'));
  api.getPaymentRequest.mockResolvedValue(record);
  api.listPaymentRequestItemsWithoutBankAccount.mockResolvedValue([]);
  banks.listCompanyBankAccounts.mockResolvedValue([bankAccount]);
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
  expect(html).toContain('Pay from bank account');
  expect(html).not.toContain('bank account ID');
  // Active rows only: the form offers no retired account.
  expect(banks.listCompanyBankAccounts).toHaveBeenCalledWith(session);
  expect(html).toContain('name="allocation:0:openItemId"');
  expect(html).toContain('name="allocation:0:amount"');
  expect(html).toContain('Himal Supplies');
  expect(html).not.toContain('Vendor ID');
  // Payment requests are exempt from the currency switch-off (D56 U16-Q1), so the page does not read it.
  expect(currencies.loadEnabledCurrencies).not.toHaveBeenCalled();
});

it('starts a ?bill= in a currency the company switched off filled in, like any other bill (D56 U16-Q1)', async () => {
  const inrBill = '55555555-5555-4555-8555-555555555555';
  currencies.loadEnabledCurrencies.mockResolvedValue(['NPR']);
  api.listPaymentRequestItems.mockResolvedValue([
    {
      ...heldItem(id, 'Himal Supplies', inrBill),
      currency: 'INR',
      availableAmount: '420.50',
    },
  ]);
  const html = renderToStaticMarkup(
    await NewPage({ searchParams: Promise.resolve({ bill: inrBill }) }),
  );
  // Old code dropped the start for a switched-off currency: the form opened on NPR with nothing claimed.
  expect(html).toMatch(/<input[^>]*name="currency"[^>]*value="INR"/);
  expect(html).toMatch(/<input[^>]*name="allocation:0:amount"[^>]*value="420.50"/);
  expect(html).not.toContain('switched off');
});

it('shows an empty state when all approved bill balances are claimed', async () => {
  api.listPaymentRequestItems.mockResolvedValue([]);
  const html = renderToStaticMarkup(await NewPage());
  expect(html).toContain('No approved bill balances');
  expect(html).not.toContain('Review request');
});

// U15b-Q6: a balance held back because the vendor has no verified bank account is named, with what to do.
const heldItem = (vendorPartyId: string, vendorName: string, vendorBillId: string) => ({
  openItemId: vendorBillId,
  vendorPartyId,
  vendorName,
  vendorBillId,
  billNumber: 'BILL-9',
  vendorInvoiceNo: 'INV-9',
  currency: 'NPR',
  openAmount: '500.00',
  claimedAmount: '0.00',
  availableAmount: '500.00',
});
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const otherVendor = '33333333-3333-4333-8333-333333333333';
const otherBill = '44444444-4444-4444-8444-444444444444';

it('says the vendor has no verified bank account, not that balances were claimed (U15b-Q6)', async () => {
  api.listPaymentRequestItems.mockResolvedValue([]);
  api.listPaymentRequestItemsWithoutBankAccount.mockResolvedValue([
    heldItem(otherVendor, 'Everest Traders', otherBill),
  ]);
  const html = renderToStaticMarkup(await NewPage());
  const text = plain(html);
  expect(text).toContain('Approved bills from Everest Traders cannot be requested yet');
  expect(text).toContain('this vendor has none');
  // Default Finance verifies bank accounts but does not propose them, so it is told who does.
  expect(text).toContain('Procurement proposes an account on the vendor’s page');
  expect(text).not.toContain('Propose a bank account');
  expect(html).toContain(`href="/vendors/${otherVendor}"`);
  expect(text).not.toContain('claimed the remaining balances');
  expect(html).not.toContain('Review request');
});

it('words the fix for a reader who may propose a bank account, and links vendors only for vendor readers', async () => {
  api.listPaymentRequestItems.mockResolvedValue([]);
  api.listPaymentRequestItemsWithoutBankAccount.mockResolvedValue([
    heldItem(otherVendor, 'Everest Traders', otherBill),
  ]);
  grants.live = new Map([
    ['payables.payment.request', 'all'],
    ['vendor.bank.propose', 'all'],
  ]);
  const html = renderToStaticMarkup(await NewPage());
  expect(plain(html)).toContain('Propose a bank account on the vendor’s page');
  // No vendor.read: the name is shown, not linked to a page that would refuse them.
  expect(plain(html)).toContain('Everest Traders');
  expect(html).not.toContain(`href="/vendors/${otherVendor}"`);
});

it('keeps the claimed-balances message when no vendor is missing a bank account, or that read fails', async () => {
  api.listPaymentRequestItems.mockResolvedValue([]);
  api.listPaymentRequestItemsWithoutBankAccount.mockRejectedValue(new Error('offline'));
  expect(plain(renderToStaticMarkup(await NewPage()))).toContain(
    'Existing requests may have claimed the remaining balances',
  );
});

it('explains a ?bill= of a vendor without a bank account while other bills stay requestable', async () => {
  api.listPaymentRequestItemsWithoutBankAccount.mockResolvedValue([
    heldItem(otherVendor, 'Everest Traders', otherBill),
  ]);
  const html = renderToStaticMarkup(
    await NewPage({ searchParams: Promise.resolve({ bill: otherBill }) }),
  );
  const text = plain(html);
  expect(text).toContain('This bill cannot be requested yet');
  expect(text).toContain('BILL-9 from Everest Traders cannot be requested yet');
  // The other vendor's balance is still offered.
  expect(html).toContain('Review request');
  // No note for a bill that can be requested.
  const ok = plain(
    renderToStaticMarkup(await NewPage({ searchParams: Promise.resolve({ bill: id }) })),
  );
  expect(ok).not.toContain('This bill cannot be requested yet');
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
  api.listPaymentRequestsPage.mockResolvedValue({ items: [record], total: 61, totals: null });
  const html = await listOf();
  expect(html).toContain('Showing 1 of 61 payment requests');
  expect(html).toContain('Showing 1–25 of 61');
  expect(html).toContain('type="search"');
  expect(html).not.toContain('Show requests');
});

it('says so when there are none, and names the filters that match none', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({ items: [], total: 0, totals: null });
  expect(await listOf()).toContain('No payment requests yet.');
  const html = await listOf({ status: 'rejected', q: 'zzz' });
  expect(html).toContain('No payment requests match.');
  expect(html).toContain('Clear filters');
});

// The pages read the live grants (GET /v1/me), not the role defaults. Accountant holds no payment request grant by
// default and Finance does, so both cases fail on the old role-default gate.
it('opens the list and the entry for a role an admin granted payment requests at own scope', async () => {
  session.roles = ['accountant'];
  grants.live = new Map([['payables.payment.request', 'own']]);
  expect(await listOf()).toContain('PAY-2083-0001');
  expect(api.listPaymentRequestsPage).toHaveBeenCalled();
  const entry = renderToStaticMarkup(await NewPage());
  expect(entry).not.toContain('Your roles do not include payment requests.');
  expect(entry).toContain('name="vendorPartyId"');
  expect(api.listPaymentRequestItems).toHaveBeenCalledOnce();
});

it('refuses Finance whose payment request grant an admin removed, before loading any data', async () => {
  grants.live = new Map([['payables.bill.read', 'all']]);
  expect(await listOf()).toContain('Your roles do not include payment requests.');
  expect(await listOf()).not.toContain('/payables/payment-requests/new');
  expect(renderToStaticMarkup(await NewPage())).toContain(
    'Your roles do not include payment requests.',
  );
  expect(api.listPaymentRequestsPage).not.toHaveBeenCalled();
  expect(api.listPaymentRequestItems).not.toHaveBeenCalled();
  expect(currencies.loadEnabledCurrencies).not.toHaveBeenCalled();
});

it('links a bill only when the live grants hold payables.bill.read', async () => {
  // Finance holds payables.bill.read by default; here an admin took it away.
  grants.live = new Map([['payables.payment.request', 'own']]);
  const without = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(without).toContain('BILL-1');
  expect(without).not.toContain(`/payables/bills/${id}`);
  // Procurement holds neither by default; an admin granted both.
  session.roles = ['procurement'];
  grants.live = new Map([
    ['payables.payment.request', 'own'],
    ['payables.bill.read', 'own'],
  ]);
  const withRead = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(withRead).toContain(`/payables/bills/${id}`);
});

it('counts each card with one limit-1 read, after the permission check', async () => {
  api.listPaymentRequestsPage.mockImplementation(
    (_s: unknown, q: { status: string[]; limit: number }) =>
      Promise.resolve({
        items: [record],
        total: q.limit === 1 ? (q.status.length === 0 ? 12 : 3) : 1,
        totals: null,
      }),
  );
  const html = await listOf({ q: 'Himal' });
  const counts = api.listPaymentRequestsPage.mock.calls
    .map((call) => call[1] as { limit: number })
    .filter((q) => q.limit === 1);
  expect(counts).toEqual([
    { status: [], limit: 1, offset: 0 },
    { status: ['draft'], limit: 1, offset: 0 },
    { status: ['pending_approval'], limit: 1, offset: 0 },
    { status: ['approved'], limit: 1, offset: 0 },
    { status: ['rejected'], limit: 1, offset: 0 },
  ]);
  expect(html).toMatch(/All requests<\/dt><dd[^>]*>12</);
  expect(html).toMatch(/Rejected<\/dt><dd[^>]*>3</);
});

it('names each vendor from the row, links it only when the vendor page would open, and reads no vendor', async () => {
  const other = '22222222-2222-4222-8222-222222222222';
  api.listPaymentRequestsPage.mockResolvedValue({
    items: [
      record,
      {
        ...record,
        id: id.replace('1', '3'),
        vendorPartyId: other,
        number: null,
        bankLast4: '9999',
        vendorName: 'Kathmandu Traders',
        can: { readVendor: false },
      },
    ],
    total: 2,
    totals: null,
  });
  const html = await listOf();
  // Old code read every vendor again and showed "Vendor name unavailable" when that read was refused.
  expect(reads.getVendor).not.toHaveBeenCalled();
  expect(html).toContain(`href="/vendors/${id}"`);
  expect(html).toContain('>Himal Supplies</a>');
  expect(html).toContain('Kathmandu Traders');
  expect(html).not.toContain(`/vendors/${other}`);
  expect(html).not.toContain('Vendor name unavailable');
});

it('ends the table with the amounts of every match, one row per currency', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({
    items: [record],
    total: 61,
    totals: [
      { currency: 'NPR', amount: '2018180.00' },
      { currency: 'USD', amount: '1500.00' },
    ],
  });
  const html = await listOf();
  const foot = /<tfoot>.*<\/tfoot>/s.exec(html)?.[0] ?? '';
  // Old code showed no total at all.
  expect(foot).toContain('Total, all pages · NPR');
  expect(foot).toContain('20,18,180.00');
  expect(foot).toContain('Total, all pages · USD');
  expect(foot).toContain('1,500.00');
});

it('pins Status and a View action to each row, named per row, with rows per page', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({
    items: [
      { ...record, number: null },
      { ...record, id: '33333333-3333-4333-8333-333333333333', number: null, bankLast4: '5678' },
    ],
    total: 2,
    totals: null,
  });
  const html = await listOf();
  const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  expect(heads.slice(-2)).toEqual(['Status', 'Action']);
  const names = [...html.matchAll(/aria-label="(View [^"]*)"/g)].map((m) => m[1]);
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
  expect(names[0]).toContain('ending 1234');
  expect(html).toContain('aria-label="Rows per page"');
});

it('puts Cancel and Review request in the heading, opening a review dialog before the form is sent', async () => {
  const html = renderToStaticMarkup(await NewPage());
  const formId = /<form id="([^"]+)"/.exec(html)?.[1];
  expect(formId).toBeTruthy();
  // The heading button opens the review; only its Confirm sends the form.
  expect(html).toMatch(/<button type="button"[^>]*aria-haspopup="dialog"[^>]*>Review request</);
  expect(html).not.toMatch(new RegExp(`<button[^>]*type="submit"[^>]*form="${formId}"`));
  expect(html.indexOf('Review request')).toBeLessThan(html.indexOf(`<form id="${formId}"`));
  expect(html.match(/<h1/g)).toHaveLength(1);
});

it('shows the approval steps on a submitted request when the approval read answers', async () => {
  api.getPaymentRequest.mockResolvedValue({
    ...record,
    status: 'pending_approval',
    approvalRequestId: id,
  });
  reads.getApprovalRequest.mockResolvedValue({
    status: 'pending',
    decidedAt: null,
    steps: [{ seq: 1, reason: 'Finance approves the payment', status: 'active' }],
  });
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('Approval history');
  expect(html).toContain('Finance approves the payment');
  reads.getApprovalRequest.mockRejectedValue(new Error('forbidden'));
  const refused = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(refused).not.toContain('Approval history');
  expect(refused).toContain(`/inbox/${id}`);
});

it('starts from the bill a "Request payment" link names, and ignores a bill it cannot request', async () => {
  const amountOf = (html: string) =>
    /<input[^>]*name="allocation:0:amount"[^>]*value="([^"]*)"/.exec(html)?.[1] ??
    /<input[^>]*value="([^"]*)"[^>]*name="allocation:0:amount"/.exec(html)?.[1];
  const started = renderToStaticMarkup(
    await NewPage({ searchParams: Promise.resolve({ bill: id }) }),
  );
  expect(started).toMatch(/name="vendorPartyId" value="11111111-1111-4111-8111-111111111111"/);
  expect(amountOf(started)).toBe('90.00');
  const other = renderToStaticMarkup(
    await NewPage({
      searchParams: Promise.resolve({ bill: '22222222-2222-4222-8222-222222222222' }),
    }),
  );
  expect(amountOf(other)).toBe('');
  const junk = renderToStaticMarkup(
    await NewPage({ searchParams: Promise.resolve({ bill: '../x' }) }),
  );
  expect(amountOf(junk)).toBe('');
});

it('reads the rows-per-page choice from the URL into the page window', async () => {
  api.listPaymentRequestsPage.mockResolvedValue({ items: [record], total: 61, totals: null });
  const html = await listOf({ rows: '100' });
  expect(api.listPaymentRequestsPage).toHaveBeenCalledWith(expect.anything(), {
    status: [],
    limit: 100,
    offset: 0,
  });
  expect(html).toMatch(/<a[^>]*aria-current="true"[^>]*>100<\/a>/);
});

const payer = (extra: [string, string][] = []) =>
  new Map<string, string>([['payables.payment.request', 'all'], ...extra]);

it('says the bank accounts did not load instead of a form without them', async () => {
  banks.listCompanyBankAccounts.mockRejectedValue(new Error('offline'));
  const html = renderToStaticMarkup(await NewPage());
  const text = html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'");
  expect(text).toContain("The company's bank accounts did not load. Reload the page to try again.");
  expect(html).toContain('role="alert"');
  expect(html).toContain('href="/payables/payment-requests/new"');
  // The page keeps its heading; the form is not drawn.
  expect(text).toContain('New payment request');
  expect(html).not.toContain('name="fromBankAccountId"');
});

it('names a refused bank account read in words about bank accounts', async () => {
  const { ApiError } = await import('@/lib/api');
  banks.listCompanyBankAccounts.mockRejectedValue(new ApiError(403, 'forbidden'));
  const text = renderToStaticMarkup(await NewPage())
    .replace(/<[^>]*>/g, '')
    .replaceAll('&#x27;', "'");
  expect(text).toContain("Your roles do not allow reading the company's bank accounts.");
});

it('links the no-account message to Settings only for someone who may open it', async () => {
  banks.listCompanyBankAccounts.mockResolvedValue([]);
  grants.live = payer([['settings.finance.write', 'all']]);
  const linked = renderToStaticMarkup(await NewPage());
  expect(linked).toContain('No active NPR bank account.');
  expect(linked).toContain('href="/settings/company-accounts"');

  grants.live = payer();
  const plain = renderToStaticMarkup(await NewPage());
  expect(plain).toContain('No active NPR bank account.');
  expect(plain).toContain('Ask an administrator to add one');
  expect(plain).not.toContain('href="/settings/company-accounts"');
});
