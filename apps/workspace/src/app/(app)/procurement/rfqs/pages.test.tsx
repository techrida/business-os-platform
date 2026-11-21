import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
// The redirect confirmation is a toast raised on mount; render its message so the page's choice shows.
vi.mock('@/components/p4/success-notice', () => ({
  SuccessNotice: ({ message }: { message: string }) => <output>{message}</output>,
}));
const session = vi.hoisted(() => ({ roles: ['procurement'] as string[] }));
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
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/procurement/rfqs',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('./actions', () => ({
  createRfqAction: vi.fn(),
  recordQuotationAction: vi.fn(),
  scoreQuotationAction: vi.fn(),
  recommendQuotationAction: vi.fn(),
  commitRfqAction: vi.fn(),
  extendDeadlineAction: vi.fn(),
}));
const rfqApi = vi.hoisted(() => ({
  listRfqsPage: vi.fn(),
  getRfq: vi.fn(),
  getComparison: vi.fn(),
  listSubmissions: vi.fn(),
}));
vi.mock('@/lib/api-rfqs', () => rfqApi);
const prApi = vi.hoisted(() => ({ listPurchaseRequests: vi.fn(), getPurchaseRequest: vi.fn() }));
vi.mock('@/lib/api-procurement', () => prApi);
const vendorApi = vi.hoisted(() => ({ listVendors: vi.fn() }));
vi.mock('@/lib/api-vendors', () => vendorApi);
const kernel = vi.hoisted(() => ({ getApprovalRequest: vi.fn() }));
vi.mock('@/lib/api-kernel', () => kernel);
const quoteApi = vi.hoisted(() => ({ listTaxCodes: vi.fn() }));
vi.mock('@/lib/api-tax-codes', () => quoteApi);
const currencies = vi.hoisted(() => ({ loadEnabledCurrencies: vi.fn() }));
vi.mock('@/lib/enabled-currencies.server', () => currencies);

const { default: ListPage } = await import('./page');
const { default: DetailPage } = await import('./[id]/page');
const { default: NewPage } = await import('./new/page');
const { default: QuotePage } = await import('./[id]/quotations/new/page');

const RFQ = '11111111-1111-4111-8111-111111111111';
const PR = '22222222-2222-4222-8222-222222222222';
const V1 = '33333333-3333-4333-8333-333333333333';
const V2 = '44444444-4444-4444-8444-444444444444';
const Q1 = '55555555-5555-4555-8555-555555555555';
const SUB = '66666666-6666-4666-8666-666666666666';
const LINE = '77777777-7777-4777-8777-777777777777';

const apiError = (status: number) =>
  new ApiError(status, 'x', {
    error: { code: 'x', message: 'internal wording', correlationId: 'corr-12345678' },
  });

const row = (over: Record<string, unknown> = {}) => ({
  id: RFQ,
  number: 'RFQ-2082/83-00001',
  purchaseRequestId: PR,
  purchaseRequestNumber: 'PR-2082/83-00007',
  status: 'open',
  deadline: '2026-12-01T10:00:00.000Z',
  invitedVendorCount: 3,
  quotationCount: 1,
  ...over,
});
const rfq = (over: Record<string, unknown> = {}) => ({
  id: RFQ,
  number: 'RFQ-2082/83-00001',
  purchaseRequestId: PR,
  deadline: '2026-12-01T10:00:00.000Z',
  status: 'open',
  vendorIds: [V1, V2],
  vendors: [
    { id: V1, name: 'Everest Supplies Pvt Ltd' },
    { id: V2, name: 'Himal Traders Pvt Ltd' },
  ],
  recommendedQuotationId: null,
  fewerThanThreeReason: null,
  recommendationRationale: null,
  commitmentApprovalRequestId: null,
  version: 1,
  ...over,
});
const quotation = {
  id: Q1,
  rfqId: RFQ,
  vendorId: V1,
  currency: 'NPR',
  subtotal: '4500000.00',
  taxAmount: '585000.00',
  total: '5085000.00',
  fxRate: '1.000000',
  totalNpr: '5085000.00',
  deliveryDays: 14,
  documentId: PR,
  vendorName: 'Everest Supplies Pvt Ltd',
  averageScore: null,
  scores: [],
};
const submission = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  vendorId: V2,
  vendorName: 'Himal Traders',
  vendorRef: 'Q-77',
  submittedAt: '2026-11-08T05:45:00.000Z',
  documentId: PR,
  scanStatus: 'clean',
  ...over,
});
const vendors = {
  items: [
    { id: V1, legalName: 'Everest Supplies Pvt Ltd', tradeName: 'Everest', status: 'approved' },
    { id: V2, legalName: 'Himal Traders Pvt Ltd', tradeName: null, status: 'approved' },
  ],
  total: 2,
};
const prDetail = {
  id: PR,
  number: 'PR-2082/83-00007',
  status: 'sourcing',
  currency: 'NPR',
  lines: [
    {
      id: LINE,
      lineNo: 1,
      description: 'Office chair',
      uom: 'pcs',
      quantity: '10.0000',
    },
  ],
};

const html = (el: unknown) => renderToStaticMarkup(el as React.ReactElement);

/**
 * The server markup of one dropdown: its root (carries data-required / data-disabled), the hidden
 * field that submits the value, and the trigger button that shows the selected label.
 */
function dropdown(out: string, name: string) {
  const match = new RegExp(
    `(<div[^>]*data-rac[^>]*>)(<input type="hidden"[^>]*name="${name}"[^>]*/>)(.*?</button>)`,
    's',
  ).exec(out);
  return match ? { root: match[1]!, field: match[2]!, trigger: match[3]! } : null;
}

/** A dropdown that cannot be used: its root, its submitted field and its trigger are all disabled. */
function expectDisabledDropdown(out: string, name: string) {
  const control = dropdown(out, name);
  expect(control).not.toBeNull();
  expect(control!.root).toContain('data-disabled="true"');
  expect(control!.field).toContain('disabled=""');
  expect(control!.trigger).toMatch(/<button[^>]*disabled=""/);
}
const page = (items: unknown[], total = items.length) => ({ items, total });
const list = async (sp: Record<string, string | string[]> = {}) =>
  html(await ListPage({ searchParams: Promise.resolve(sp) }));
const detail = async (sp: Record<string, string> = {}) =>
  html(
    await DetailPage({ params: Promise.resolve({ id: RFQ }), searchParams: Promise.resolve(sp) }),
  );
const newPage = async (sp: Record<string, string> = {}) =>
  html(await NewPage({ searchParams: Promise.resolve(sp) }));
const quotePage = async (sp: Record<string, string> = {}) =>
  html(
    await QuotePage({ params: Promise.resolve({ id: RFQ }), searchParams: Promise.resolve(sp) }),
  );

// The pages compare the RFQ deadline (1 Dec 2026 in the fixtures) with now (F1-Q47): pin now before it.
const BEFORE_DEADLINE = new Date('2026-11-15T00:00:00Z');
const AFTER_DEADLINE = new Date('2026-12-02T00:00:00Z');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BEFORE_DEADLINE);
  session.roles = ['procurement'];
  me.getMe.mockReset().mockRejectedValue(new Error('offline'));
  currencies.loadEnabledCurrencies.mockResolvedValue(['NPR', 'INR', 'USD']);
  rfqApi.getRfq.mockResolvedValue(rfq());
  rfqApi.getComparison.mockResolvedValue([quotation]);
  rfqApi.listSubmissions.mockResolvedValue([]);
  prApi.getPurchaseRequest.mockResolvedValue(prDetail);
  prApi.listPurchaseRequests.mockResolvedValue([]);
  vendorApi.listVendors.mockResolvedValue(vendors);
  quoteApi.listTaxCodes.mockResolvedValue([{ id: Q1, label: 'VAT 13%', rate: '13' }]);
});

describe('the list', () => {
  it('shows the rows with the request number, Kathmandu deadline and counts', async () => {
    rfqApi.listRfqsPage.mockResolvedValue(page([row()]));
    const out = await list();
    expect(out).toContain('RFQ-2082/83-00001');
    expect(out).toContain('PR-2082/83-00007');
    expect(out).toContain('1 of 3');
    expect(out).toContain('>Open</');
    expect(out).toContain('New RFQ');
    expect(out).toContain('15:45');
  });

  it('passes repeated statuses, the search and the page window, dropping a bogus status', async () => {
    rfqApi.listRfqsPage.mockResolvedValue(page([]));
    await list({ status: ['recommended', 'bogus', 'open'], q: 'RFQ-2082', page: '2' });
    expect(rfqApi.listRfqsPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['recommended', 'open'],
      q: 'RFQ-2082',
      limit: 25,
      offset: 25,
    });
    await list({});
    expect(rfqApi.listRfqsPage).toHaveBeenLastCalledWith(expect.anything(), {
      status: [],
      limit: 25,
      offset: 0,
    });
  });

  it('shows the total and range, a search box and no Apply button', async () => {
    rfqApi.listRfqsPage.mockResolvedValue(page([row()], 60));
    const out = await list({ status: 'open' });
    expect(out).toContain('Showing 1 of 60 RFQs');
    expect(out).toContain('Showing 1–25 of 60');
    expect(out).toContain('aria-label="Rows per page"');
    expect(out).toContain('type="search"');
    expect(out).not.toContain('>Apply<');
  });

  it('says so when there are none, and names the filters that match none', async () => {
    rfqApi.listRfqsPage.mockResolvedValue(page([]));
    expect(await list()).toContain('No RFQs yet.');
    const out = await list({ status: ['closed', 'open'], q: 'zzz' });
    expect(out).toContain('No RFQs match.');
    expect(out).toContain('Status: Closed, Open');
    expect(out).toContain('Clear filters');
  });

  it('counts the RFQs per card with one-row reads, and ends each row with a View link', async () => {
    rfqApi.listRfqsPage.mockImplementation(
      (_s: unknown, query: { status?: string[]; limit: number }) =>
        Promise.resolve(
          query.limit === 1
            ? page([], (query.status ?? [])[0] === 'closed' ? 2 : 7)
            : page([row()], 7),
        ),
    );
    const out = await list();
    expect(out).toContain('aria-label="RFQ summary"');
    expect(out).toMatch(/Waiting for a recommendation<\/dt><dd[^>]*>2</);
    expect(out).toMatch(/Total RFQs<\/dt><dd[^>]*>7</);
    expect(rfqApi.listRfqsPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['recommended'],
      limit: 1,
      offset: 0,
    });
    expect(out).toContain('>Action</th>');
    expect(out).toContain('aria-label="View RFQ-2082/83-00001"');
  });

  it('leaves the cards out when a count fails', async () => {
    rfqApi.listRfqsPage.mockImplementation((_s: unknown, query: { limit: number }) =>
      query.limit === 1 ? Promise.reject(apiError(500)) : Promise.resolve(page([row()])),
    );
    const out = await list();
    expect(out).not.toContain('RFQ summary');
    expect(out).toContain('RFQ-2082/83-00001');
  });

  it('leaves the cards out when the list itself fails, even though the counts loaded', async () => {
    rfqApi.listRfqsPage.mockImplementation((_s: unknown, query: { limit: number }) =>
      query.limit === 1 ? Promise.resolve(page([], 3)) : Promise.reject(apiError(500)),
    );
    const out = await list();
    expect(out).toContain('did not load');
    expect(out).not.toContain('RFQ summary');
  });

  it('a person without the sourcing grant gets no New RFQ button', async () => {
    session.roles = ['sales'];
    rfqApi.listRfqsPage.mockResolvedValue(page([]));
    expect(await list()).not.toContain('New RFQ');
  });

  it('403 is an info alert and a failure is an error with a reload link', async () => {
    rfqApi.listRfqsPage.mockRejectedValue(apiError(403));
    expect(await list()).toContain('Your roles do not include sourcing');
    rfqApi.listRfqsPage.mockRejectedValue(new ApiError(502, 'x'));
    const out = await list();
    expect(out).toContain('did not load');
    expect(out).toContain('Reload the list');
  });
});

describe('the detail', () => {
  it('shows vendor names, the PR number and server money in lakh grouping', async () => {
    const out = await detail();
    expect(out).toContain('Everest');
    expect(out).toContain('Himal Traders Pvt Ltd');
    expect(out).toContain('PR-2082/83-00007');
    expect(out).toContain('50,85,000.00');
    expect(out).toContain('14 days');
    expect(out).toContain('Not scored');
    expect(out).toContain('Enter a quotation');
  });

  it('names the invited and quoting vendors from the RFQ itself, with no vendor directory read', async () => {
    vendorApi.listVendors.mockRejectedValue(apiError(403));
    const out = await detail();
    expect(out).toContain('Everest Supplies Pvt Ltd, Himal Traders Pvt Ltd');
    expect(out).not.toContain('Vendor name unavailable');
    expect(vendorApi.listVendors).not.toHaveBeenCalled();
    const quote = await quotePage();
    expect(quote).toContain('Everest Supplies Pvt Ltd');
    expect(quote).toContain('Himal Traders Pvt Ltd');
    expect(quote).not.toContain('Vendor name unavailable');
    expect(vendorApi.listVendors).not.toHaveBeenCalled();
  });

  it('only a clean scan gets a Convert button; the others say why', async () => {
    rfqApi.listSubmissions.mockResolvedValue([
      submission(),
      submission({ id: Q1, vendorName: 'Slow Scanner', scanStatus: 'quarantined' }),
      submission({ id: PR, vendorName: 'No File', scanStatus: null }),
    ]);
    const out = await detail();
    expect(out).toContain('Convert the submission from Himal Traders');
    expect(out).not.toContain('Convert the submission from Slow Scanner');
    expect(out).not.toContain('Convert the submission from No File');
    expect(out).toContain('still being scanned');
    expect(out).toContain('no file version yet');
    expect(out).toContain(`/quotations/new?submission=${SUB}`);
  });

  it('a closed RFQ offers neither entry nor convert and does not fetch submissions', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'closed' }));
    const out = await detail();
    expect(out).not.toContain('Enter a quotation');
    expect(rfqApi.listSubmissions).not.toHaveBeenCalled();
  });

  it('a comparison that fails is a message, not a blank page', async () => {
    rfqApi.getComparison.mockRejectedValue(new ApiError(502, 'x'));
    const out = await detail();
    expect(out).toContain('Quotations did not load');
  });

  it('shows the commitment approval steps when one exists', async () => {
    rfqApi.getRfq.mockResolvedValue(
      rfq({ status: 'recommended', recommendedQuotationId: Q1, commitmentApprovalRequestId: PR }),
    );
    kernel.getApprovalRequest.mockResolvedValue({
      status: 'in_progress',
      decidedAt: null,
      steps: [{ seq: 1, reason: 'An Accountant checks the quotation', status: 'active' }],
    });
    const out = await detail();
    expect(out).toContain('An Accountant checks the quotation');
    expect(out).toContain('Recommended');
  });

  it('an open RFQ before its deadline offers entry and the extension in the header (F1-Q47)', async () => {
    const out = await detail();
    const header = out.slice(0, out.indexOf('<section'));
    expect(header).toContain('>Enter a quotation<');
    expect(header).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Extend deadline<\/button>/);
    expect(out).not.toContain('The quotation deadline has passed');
  });

  it('after the deadline: no entry, a notice, the extension, and late uploads cannot be converted (F1-Q47)', async () => {
    vi.setSystemTime(AFTER_DEADLINE);
    rfqApi.listSubmissions.mockResolvedValue([
      submission({ submittedAt: '2026-11-30T05:45:00.000Z' }),
      submission({ id: Q1, vendorName: 'Late Sender', submittedAt: '2026-12-01T10:00:01.000Z' }),
    ]);
    const out = await detail();
    const header = out.slice(0, out.indexOf('<section'));
    expect(header).not.toContain('>Enter a quotation<');
    expect(header).toContain('>Extend deadline<');
    expect(out).toContain('The quotation deadline has passed');
    expect(out).toContain('(passed)');
    // Sent before the deadline: still convertible after it.
    expect(out).toContain('Convert the submission from Himal Traders');
    expect(out).not.toContain('Convert the submission from Late Sender');
    expect(out).toContain('Arrived late');
  });

  it('a viewer after the deadline sees the notice without the extension', async () => {
    vi.setSystemTime(AFTER_DEADLINE);
    session.roles = ['viewer'];
    const out = await detail();
    expect(out).toContain('The quotation deadline has passed');
    expect(out).not.toContain('>Extend deadline<');
    expect(out).toContain('A quotation already received can still be recommended.');
  });

  it('a missing RFQ is a 404 and a failed load is an alert', async () => {
    rfqApi.getRfq.mockRejectedValue(apiError(404));
    await expect(detail()).rejects.toThrow('NOT_FOUND');
    rfqApi.getRfq.mockRejectedValue(new ApiError(502, 'x'));
    expect(await detail()).toContain('The RFQ did not load');
  });
});

describe('the new RFQ page', () => {
  it('refuses a person without the sourcing grant', async () => {
    session.roles = ['sales'];
    expect(await newPage()).toContain('Your roles do not include sourcing');
  });

  it('says when no purchase request is ready, and when no vendor is approved', async () => {
    expect(await newPage()).toContain('No purchase request is ready for an RFQ');
    prApi.listPurchaseRequests.mockResolvedValue([
      {
        id: PR,
        number: 'PR-2082/83-00007',
        estimatedTotal: '4500000.00',
        currency: 'NPR',
        requiredBy: '2026-12-01',
        justification: 'Chairs',
      },
    ]);
    vendorApi.listVendors.mockResolvedValue({ items: [], total: 0 });
    expect(await newPage()).toContain('No approved vendors to invite');
  });

  it('asks only for dept_approved requests and approved vendors, and preselects ?pr=', async () => {
    prApi.listPurchaseRequests.mockResolvedValue([
      {
        id: PR,
        number: 'PR-2082/83-00007',
        estimatedTotal: '4500000.00',
        currency: 'NPR',
        requiredBy: '2026-12-01',
        justification: 'Chairs',
      },
    ]);
    const out = await newPage({ pr: PR });
    expect(prApi.listPurchaseRequests).toHaveBeenCalledWith(expect.anything(), {
      status: 'dept_approved',
      limit: 100,
    });
    expect(vendorApi.listVendors).toHaveBeenCalledWith(expect.anything(), {
      status: 'approved',
      limit: 100,
    });
    expect(out).toContain('45,00,000.00');
    expect(out).toContain('Quotation deadline');
    expect(out).toContain('Everest');
    expect(out).toContain('Open RFQ');
    expect(dropdown(out, 'purchaseRequestId')!.field).toContain(`value="${PR}"`);
    expect(dropdown(out, 'purchaseRequestId')!.trigger).toContain('PR-2082/83-00007');
  });
});

describe('the quotation entry page', () => {
  it('lists the purchase request lines and the invited vendors', async () => {
    const out = await quotePage();
    expect(out).toContain('Record quotation');
    expect(out).toContain('Office chair');
    expect(out).toContain('Everest');
    expect(out).toContain('Quotation document');
  });

  it('renders a labelled tax-code select with the API ids as option values', async () => {
    const out = await quotePage();
    const taxCode = dropdown(out, 'lines\\.0\\.taxCodeId');
    expect(taxCode).not.toBeNull();
    // Usable, and the API id is what the form submits for the option it lists.
    expect(taxCode!.root).not.toContain('data-disabled');
    expect(taxCode!.field).not.toContain('disabled');
    expect(out).toContain(`<option value="${Q1}">VAT 13%</option>`);
    // No free-text id input: only the dropdown's hidden field carries the name.
    expect(out).not.toMatch(/<input(?![^>]*type="hidden")[^>]*name="lines\.0\.taxCodeId"/);
  });

  it('explains a refused tax lookup without offering a retry', async () => {
    quoteApi.listTaxCodes.mockRejectedValue(apiError(403));
    const out = await quotePage();
    expect(out).toContain('Your roles do not include tax codes');
    expect(out).toContain('Ask an administrator');
    expect(out).not.toContain('Try loading tax codes again');
    expect(out).not.toContain('Try again');
    expectDisabledDropdown(out, 'lines\\.0\\.taxCodeId');
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('disables entry with a retry when tax codes fail', async () => {
    quoteApi.listTaxCodes.mockRejectedValue(apiError(500));
    const out = await quotePage();
    expect(out).toContain('Tax codes did not load');
    expect(out).toContain('Try loading tax codes again');
    expect(out).toContain(`/procurement/rfqs/${RFQ}/quotations/new`);
    expectDisabledDropdown(out, 'lines\\.0\\.taxCodeId');
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    // No free-text id input: only the dropdown's hidden field carries the name.
    expect(out).not.toMatch(/<input(?![^>]*type="hidden")[^>]*name="lines\.0\.taxCodeId"/);
    expect(out).not.toContain('Enter its id');
  });

  it('explains an empty tax registry and prevents submission', async () => {
    quoteApi.listTaxCodes.mockResolvedValue([]);
    const out = await quotePage();
    expect(out).toContain('No tax codes are available');
    expect(out).toContain('Ask an administrator to configure tax codes');
    expectDisabledDropdown(out, 'lines\\.0\\.taxCodeId');
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('keeps the submission conversion link when retrying tax codes', async () => {
    quoteApi.listTaxCodes.mockRejectedValue(apiError(500));
    rfqApi.listSubmissions.mockResolvedValue([submission()]);
    const out = await quotePage({ submission: SUB });
    expect(out).toContain(`/procurement/rfqs/${RFQ}/quotations/new?submission=${SUB}`);
    expect(out).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it('a closed RFQ takes no quotation', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'closed' }));
    expect(await quotePage()).toContain('This RFQ takes no more quotations');
  });

  it('converting needs a clean scan and hides the vendor and document fields', async () => {
    rfqApi.listSubmissions.mockResolvedValue([submission()]);
    const out = await quotePage({ submission: SUB });
    expect(out).toContain('Convert to quotation');
    expect(out).toContain('Himal Traders');
    expect(out).not.toContain('Quotation document');
    rfqApi.listSubmissions.mockResolvedValue([submission({ scanStatus: 'infected' })]);
    expect(await quotePage({ submission: SUB })).toContain('cannot be converted yet');
    rfqApi.listSubmissions.mockResolvedValue([]);
    expect(await quotePage({ submission: SUB })).toContain('That submission is not waiting');
  });

  it('a person without the grant is turned away before the form', async () => {
    session.roles = ['sales'];
    const out = await quotePage();
    expect(out).toContain('Your roles do not include sourcing');
    expect(out).not.toContain('Record quotation');
  });
});

describe('scoring, recommending and committing on the detail', () => {
  const Q2 = '88888888-8888-4888-8888-888888888888';
  const scored = {
    ...quotation,
    averageScore: '76.25',
    scores: [{ criterion: 'Price', score: '80.00', comment: null }],
  };
  const second = {
    ...quotation,
    id: Q2,
    vendorId: V2,
    vendorName: 'Himal Traders Pvt Ltd',
    total: '6000000.00',
    totalNpr: '6000000.00',
  };

  it('an open RFQ with quotations offers a score form for each and one recommendation form', async () => {
    rfqApi.getComparison.mockResolvedValue([scored, second]);
    const out = await detail();
    expect(out).toContain('Score the quotations');
    expect(out).toContain('Score Everest');
    expect(out).toContain('Score Himal Traders Pvt Ltd');
    expect(out.match(/Save scores/g)).toHaveLength(2);
    expect(out).toContain('Why this quotation');
    expect(out).toContain('Recommend this quotation');
    // What the API already holds, as it sent it.
    expect(out).toContain('76.25');
    expect(out).toContain('80.00');
  });

  it('the fewer-quotations reason is always on the form and never names a fixed number', async () => {
    const out = await detail();
    expect(out).toContain('If fewer quotations than required');
    expect(out).not.toMatch(/\bthree\b/i);
    expect(out).toContain('name="fewerThanThreeReason"');
    expect(out).toContain('maxLength="1000"');
  });

  it('the recommendation lists the quotations by vendor and server total', async () => {
    rfqApi.getComparison.mockResolvedValue([scored, second]);
    const out = await detail();
    expect(out).toMatch(/Everest Supplies Pvt Ltd, [^<]*50,85,000\.00/);
    expect(out).toContain(`value="${Q2}"`);
  });

  it('a closed RFQ still takes scores and a recommendation', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'closed' }));
    const out = await detail();
    expect(out).toContain('Score the quotations');
    expect(out).toContain('Why this quotation');
  });

  it('no quotations, no grant, a recommended or cancelled RFQ: no forms', async () => {
    rfqApi.getComparison.mockResolvedValue([]);
    expect(await detail()).not.toContain('Why this quotation');
    rfqApi.getComparison.mockResolvedValue([quotation]);
    session.roles = ['viewer'];
    const viewer = await detail();
    expect(viewer).not.toContain('Score the quotations');
    expect(viewer).not.toContain('Why this quotation');
    session.roles = ['procurement'];
    for (const status of ['recommended', 'cancelled']) {
      rfqApi.getRfq.mockResolvedValue(rfq({ status, recommendedQuotationId: Q1 }));
      const out = await detail();
      expect(out).not.toContain('Score the quotations');
      expect(out).not.toContain('Why this quotation');
    }
  });

  it('a failed comparison offers no forms', async () => {
    rfqApi.getComparison.mockRejectedValue(new ApiError(502, 'x'));
    const out = await detail();
    expect(out).toContain('Quotations did not load');
    expect(out).not.toContain('Why this quotation');
  });

  it('a recommended RFQ on a sourcing request offers the commitment submit', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'recommended', recommendedQuotationId: Q1 }));
    const out = await detail();
    expect(out).toMatch(
      /<button[^>]*aria-haspopup="dialog"[^>]*>Submit for commitment approval<\/button>/,
    );
  });

  it('puts the commitment submit in the page header, not in a side panel', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'recommended', recommendedQuotationId: Q1 }));
    const out = await detail();
    const header = out.slice(0, out.indexOf('<section'));
    expect(header).toContain('Submit for commitment approval');
    expect(out.match(/Submit for commitment approval/g)).toHaveLength(1);
    expect(out).not.toContain(
      'Send the recommended quotation to be approved before a purchase order.',
    );
    // A recommended RFQ takes no quotation and no deadline extension.
    expect(header).not.toContain('>Enter a quotation<');
    expect(header).not.toContain('>Extend deadline<');
  });

  it('shows no submit once the request waits on the approvers, and the approval panel appears', async () => {
    rfqApi.getRfq.mockResolvedValue(
      rfq({ status: 'recommended', recommendedQuotationId: Q1, commitmentApprovalRequestId: PR }),
    );
    prApi.getPurchaseRequest.mockResolvedValue({ ...prDetail, status: 'commitment_pending' });
    kernel.getApprovalRequest.mockResolvedValue({
      status: 'in_progress',
      decidedAt: null,
      steps: [{ seq: 1, reason: 'An Accountant checks the quotation', status: 'active' }],
    });
    const out = await detail();
    expect(out).not.toContain('Submit for commitment approval');
    expect(out).toContain('Commitment approval');
    expect(out).toContain('An Accountant checks the quotation');
  });

  it('a request sent back to sourcing can be submitted again', async () => {
    rfqApi.getRfq.mockResolvedValue(
      rfq({ status: 'recommended', recommendedQuotationId: Q1, commitmentApprovalRequestId: PR }),
    );
    kernel.getApprovalRequest.mockResolvedValue({ status: 'rejected', decidedAt: null, steps: [] });
    expect(await detail()).toContain('Submit for commitment approval');
  });

  it('when the purchase request did not load, hides the submit and says why', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'recommended', recommendedQuotationId: Q1 }));
    prApi.getPurchaseRequest.mockRejectedValue(new ApiError(502, 'x'));
    const out = await detail();
    expect(out).not.toContain('Submit for commitment approval');
    expect(out).toMatch(/purchase request did not load/i);
  });

  it('a person without the grant gets no submit', async () => {
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'recommended', recommendedQuotationId: Q1 }));
    session.roles = ['viewer'];
    expect(await detail()).not.toContain('Submit for commitment approval');
  });

  it('respects live permissions and hides RFQ actions when procurement.sourcing is revoked', async () => {
    session.roles = ['procurement'];
    const granted = { permissions: [{ permission: 'procurement.sourcing', scope: 'all' }] };
    const revoked = { permissions: [{ permission: 'procurement.rfq.read', scope: 'all' }] };
    // An open RFQ: with the live grant the header offers entry and the deadline extension.
    me.getMe.mockResolvedValue(granted);
    const open = await detail();
    expect(open).toContain('>Enter a quotation<');
    expect(open).toContain('>Extend deadline<');
    me.getMe.mockResolvedValue(revoked);
    const openRevoked = await detail();
    expect(openRevoked).not.toContain('>Enter a quotation<');
    expect(openRevoked).not.toContain('>Extend deadline<');
    // A recommended RFQ: the commitment submit follows the same grant.
    rfqApi.getRfq.mockResolvedValue(rfq({ status: 'recommended', recommendedQuotationId: Q1 }));
    me.getMe.mockResolvedValue(granted);
    expect(await detail()).toContain('Submit for commitment approval');
    me.getMe.mockResolvedValue(revoked);
    expect(await detail()).not.toContain('Submit for commitment approval');
  });

  it('confirms a recommendation after the redirect', async () => {
    const out = await detail({ recommended: '1' });
    expect(out).toContain('The quotation was recommended.');
  });
});

describe('the new RFQ vendor panel wording', () => {
  it('does not imply a fixed number of quotations', async () => {
    prApi.listPurchaseRequests.mockResolvedValue([
      {
        id: PR,
        number: 'PR-2082/83-00007',
        estimatedTotal: '4500000.00',
        currency: 'NPR',
        requiredBy: '2026-12-01',
        justification: 'Chairs',
      },
    ]);
    const out = await newPage();
    expect(out).not.toContain('needs three');
    expect(out).toContain('Only approved vendors with an account in this entity can be invited.');
    expect(out).toContain('minimum number of quotations');
  });
});

/** Values and labels of the currency picker: the shared Select's hidden native <select> after its named field. */
function currencyOptions(out: string) {
  const select = /name="currency" value="[^"]*"\/><button.*?<select[^>]*>(.*?)<\/select>/s.exec(
    out,
  )?.[1];
  return [...(select ?? '').matchAll(/<option[^>]*value="([^"]+)"[^>]*>([^<]*)</g)].map(
    (m) => `${m[1]}=${m[2]}`,
  );
}

describe('the quotation entry currency picker (D44)', () => {
  it('offers only the enabled currencies', async () => {
    currencies.loadEnabledCurrencies.mockResolvedValue(['NPR', 'USD']);
    const out = await quotePage();
    expect(currencies.loadEnabledCurrencies).toHaveBeenCalledOnce();
    expect(currencyOptions(out)).toEqual(['NPR=NPR', 'USD=USD']);
  });
});

describe('the quotation entry page after the deadline (F1-Q47)', () => {
  it('blocks typing a quotation in and points to the extension', async () => {
    vi.setSystemTime(AFTER_DEADLINE);
    const out = await quotePage();
    expect(out).toContain('The quotation deadline has passed');
    expect(out).toContain('Extend the deadline on the RFQ to enter more.');
    expect(out).not.toContain('name="vendorId"');
  });

  it('still converts an upload sent before the deadline, and refuses a late one', async () => {
    vi.setSystemTime(AFTER_DEADLINE);
    rfqApi.listSubmissions.mockResolvedValue([submission()]);
    const inTime = await quotePage({ submission: SUB });
    expect(inTime).not.toContain('The quotation deadline has passed');
    expect(inTime).not.toContain('cannot be converted');
    rfqApi.listSubmissions.mockResolvedValue([
      submission({ submittedAt: '2026-12-01T10:00:01.000Z' }),
    ]);
    const late = await quotePage({ submission: SUB });
    expect(late).toContain('sent after the quotation deadline');
  });
});
