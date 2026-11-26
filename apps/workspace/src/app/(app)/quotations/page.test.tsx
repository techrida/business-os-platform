import {
  avatarColour,
  imagePath,
  OpportunityDtoSchema,
  type QuotationListItem,
} from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import QuotationsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listQuotationsPage: vi.fn(),
  getQuotationsSummary: vi.fn(),
  listCustomers: vi.fn(),
  getOpportunity: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quotations/api', () => ({
  listQuotationsPage: mocks.listQuotationsPage,
  getQuotationsSummary: mocks.getQuotationsSummary,
}));
vi.mock('@/components/p2/customers/api', () => ({ listCustomers: mocks.listCustomers }));
vi.mock('@/components/p2/crm/crm-api', () => ({ getOpportunity: mocks.getOpportunity }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/quotations',
  useSearchParams: () => new URLSearchParams(),
}));

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const OPP = '11111111-1111-4111-8111-111111111111';
const Q1 = '55555555-5555-4555-8555-555555555551';

/** A deal as `GET /v1/opportunities/:id` sends it, through the contract (optional fields omitted). */
const dealDto = (over: Record<string, unknown> = {}) =>
  OpportunityDtoSchema.parse({
    id: OPP,
    number: 'DEAL-0042',
    name: 'Bridge works',
    customerId: '33333333-3333-4333-8333-333333333333',
    contactId: null,
    leadId: null,
    ownerUserId: null,
    ownerName: null,
    stage: 'negotiation',
    stageReason: null,
    lostReason: null,
    stageNote: null,
    value: null,
    currency: 'NPR',
    probability: null,
    expectedClose: null,
    wonQuotationVersionId: null,
    version: 1,
    createdAt: '2026-11-08T05:45:00.000Z',
    updatedAt: '2026-11-08T05:45:00.000Z',
    ...over,
  });

const item = {
  id: Q1,
  number: 'QT-2082-0001',
  customerId: OPP,
  opportunityId: OPP,
  currentVersionId: Q1,
  ownerUserId: null,
  status: 'draft',
  version: 1,
  createdAt: '2026-11-08T05:45:00.000Z',
  updatedAt: '2026-11-08T05:45:00.000Z',
  customerName: 'Himal Traders',
  currency: 'NPR',
  total: '1000.00',
  validUntil: '2026-12-08',
  ownerName: null,
  canEdit: true,
} satisfies QuotationListItem;

const SUMMARY = {
  total: 12,
  byStatus: {
    draft: 3,
    submitted: 2,
    returned: 0,
    approved: 0,
    sent: 4,
    accepted: 3,
    rejected: 0,
    expired: 0,
    cancelled: 0,
    superseded: 0,
  },
};
const page = (items: QuotationListItem[] = [item], total = items.length) => ({ items, total });

async function render(query: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await QuotationsPage({ searchParams: Promise.resolve(query) }));
}

const lastFilter = (): Record<string, unknown> | undefined =>
  mocks.listQuotationsPage.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  mocks.listQuotationsPage.mockReset().mockResolvedValue(page());
  mocks.getOpportunity.mockReset().mockResolvedValue(dealDto({ canDraftQuotation: true }));
  mocks.getQuotationsSummary.mockReset().mockResolvedValue(SUMMARY);
  mocks.listCustomers.mockReset().mockResolvedValue({
    items: [{ id: CUSTOMER, legalName: 'Himal Traders' }],
    total: null,
  });
});

describe('quotations list', () => {
  it('asks the server for the first page and shows the matching count', async () => {
    const html = await render();
    expect(lastFilter()).toEqual({ status: [], customerId: [], limit: 5, offset: 0 });
    expect(html).toContain('<h1');
    expect(html).toContain('1 quotation');
    expect(html).not.toContain('another=1');
    expect(html).not.toContain('name="opportunityId"');
    expect(html).not.toContain('Apply');
  });

  it("shows the owner's picture over the colour seeded from their user id", async () => {
    const owner = '9f1c2e4a-6b7d-4e8f-a1b2-c3d4e5f60718';
    const picture = '88888888-8888-4888-8888-888888888888';
    mocks.listQuotationsPage.mockResolvedValue(
      page([
        {
          ...item,
          ownerUserId: owner,
          ownerName: 'Asha Gurung',
          ownerAvatarDocumentId: picture,
        },
      ]),
    );
    // The id must not land on the unseeded colour, or this check would pass without a seed.
    expect(avatarColour(owner)).not.toBe(avatarColour(null));
    const html = await render();
    expect(html).toContain(`src="${imagePath(picture)}"`);
    expect(html).toContain(`--avatar-fill:${avatarColour(owner)}`);
  });

  it('sends repeated statuses, customers and the search, and trims nothing the API would refuse', async () => {
    await render({
      status: ['draft', 'sent', 'nonsense'],
      customerId: [CUSTOMER, 'x'],
      q: ' himal ',
    });
    expect(lastFilter()).toEqual({
      status: ['draft', 'sent'],
      customerId: [CUSTOMER],
      q: 'himal',
      limit: 5,
      offset: 0,
    });
  });

  it('turns page and rows into limit and offset', async () => {
    mocks.listQuotationsPage.mockResolvedValue(page([item], 40));
    await render({ page: '3', rows: '10' });
    expect(lastFilter()).toMatchObject({ limit: 10, offset: 20 });
  });

  it('filters by opportunity (demo feedback: View quotations ignored it), keeping it through the status filter', async () => {
    const html = await render({ opportunityId: OPP, status: 'draft' });
    expect(lastFilter()).toMatchObject({ status: ['draft'], opportunityId: OPP });
    expect(html).toContain('Quotations for this opportunity');
    expect(html).toContain(`<input type="hidden" name="opportunityId" value="${OPP}"/>`);
    // Starting another quotation from here is deliberate, so the New page does not resume a draft.
    expect(html).toContain(`href="/quotations/new?opportunityId=${OPP}&amp;another=1"`);
    expect(html).toContain(`href="/opportunities/${OPP}"`);
  });

  it('offers New quotation for a deal only when the deal says the caller may quote on it (FX-Q2)', async () => {
    const newHref = `href="/quotations/new?opportunityId=${OPP}&amp;another=1"`;
    mocks.getOpportunity.mockResolvedValue(dealDto({ canDraftQuotation: false }));
    expect(await render({ opportunityId: OPP })).not.toContain(newHref);

    mocks.getOpportunity.mockResolvedValue(dealDto());
    expect(await render({ opportunityId: OPP })).not.toContain(newHref);

    mocks.getOpportunity.mockResolvedValue(dealDto({ stage: 'won', canDraftQuotation: true }));
    expect(await render({ opportunityId: OPP })).not.toContain(newHref);

    mocks.getOpportunity.mockRejectedValue(new ApiError(404, 'missing'));
    const html = await render({ opportunityId: OPP });
    expect(html).not.toContain(newHref);
    expect(html).toContain('Quotations for this opportunity');
    expect(mocks.getOpportunity).toHaveBeenCalledWith(expect.anything(), OPP);
  });

  it('ignores an opportunityId that is not a UUID', async () => {
    await render({ opportunityId: '../x' });
    expect(lastFilter()).not.toHaveProperty('opportunityId');
  });

  it('offers Edit only when the list capability permits it', async () => {
    mocks.listQuotationsPage.mockResolvedValue(
      page([
        { ...item, status: 'returned' },
        { ...item, id: OPP, number: 'QT-2082-0042', status: 'returned', canEdit: false },
      ]),
    );

    const html = await render();
    expect(html).toContain(`aria-label="Edit QT-2082-0001" href="/quotations/${Q1}/edit"`);
    expect(html).not.toContain(`href="/quotations/${OPP}/edit"`);
    expect(html).toContain(`aria-label="View QT-2082-0042" href="/quotations/${OPP}"`);
  });

  it('shows the window and page links from the total, carrying filters and rows onward', async () => {
    mocks.listQuotationsPage.mockResolvedValue(
      page(
        Array.from({ length: 2 }, (_, index) => ({
          ...item,
          id: `quotation-${index + 6}`,
          number: `QT-2082-000${index + 6}`,
        })),
        7,
      ),
    );

    const html = await render({
      opportunityId: OPP,
      status: ['draft', 'sent'],
      q: 'HIMAL',
      page: '2',
    });

    expect(html).toContain('Showing 6–7 of 7');
    expect(html).toContain('Showing 2 of 7 quotations');
    // Page 1 drops `page`; every filter and the scope stay in the link.
    expect(html).toContain(
      `href="/quotations?opportunityId=${OPP}&amp;status=draft&amp;status=sent&amp;q=HIMAL"`,
    );
    // Changing rows drops the page too, and the default stays out of the URL.
    expect(html).toContain(
      `href="/quotations?opportunityId=${OPP}&amp;status=draft&amp;status=sent&amp;q=HIMAL&amp;rows=10"`,
    );
  });

  it('reads the last page when the requested page is past the end', async () => {
    mocks.listQuotationsPage
      .mockResolvedValueOnce(page([], 7))
      .mockResolvedValueOnce(page([item], 7));
    await render({ page: '9' });
    expect(mocks.listQuotationsPage).toHaveBeenCalledTimes(2);
    expect(lastFilter()).toMatchObject({ limit: 5, offset: 5 });
  });

  it('draws the cards from the summary, for the same search and customers but never the status', async () => {
    const html = await render({
      status: 'sent',
      q: 'himal',
      customerId: CUSTOMER,
      opportunityId: OPP,
    });
    expect(html).toContain('aria-label="Quotation totals by status"');
    expect(html).toContain('Matching quotations');
    expect(html).toContain('>12<');
    expect(mocks.getQuotationsSummary).toHaveBeenCalledWith(expect.anything(), {
      customerId: [CUSTOMER],
      opportunityId: OPP,
      q: 'himal',
    });
    expect(await render()).toContain('Total quotations');
  });

  it('adds what each status is worth only when it is one currency', async () => {
    const empty = Object.fromEntries(Object.keys(SUMMARY.byStatus).map((k) => [k, []]));
    mocks.getQuotationsSummary.mockResolvedValue({
      ...SUMMARY,
      amounts: {
        ...empty,
        submitted: [{ currency: 'NPR', total: '245000.00' }],
        sent: [
          { currency: 'NPR', total: '610000.00' },
          { currency: 'USD', total: '90.00' },
        ],
      },
    });
    const html = await render();
    expect(html).toMatch(/2,?45,000\.00/);
    expect(html).toContain('requiring approval');
    // Mixed currencies and an empty status keep the count and drop the amount.
    expect(html).not.toContain('outstanding');
    expect(html).not.toContain('contracted');
  });

  it('still lists the quotations when the summary or the customers cannot be read', async () => {
    mocks.getQuotationsSummary.mockRejectedValue(new Error('down'));
    mocks.listCustomers.mockRejectedValue(new Error('down'));
    const html = await render();
    expect(html).toContain('QT-2082-0001');
    expect(html).not.toContain('Quotation totals by status');
    expect(html).toContain('All statuses');
    expect(html).not.toContain('All customers');
  });

  it('names the filters hiding the rows and offers Clear filters that keeps the scope and rows', async () => {
    mocks.listQuotationsPage.mockResolvedValue(page([], 0));
    const html = await render({
      opportunityId: OPP,
      status: ['draft', 'sent'],
      customerId: CUSTOMER,
      q: 'zzz',
      rows: '10',
      page: '2',
    });
    expect(html).toContain('No matching quotations.');
    expect(html).toContain('Search “zzz” · Status: Draft, Sent · Customer: Himal Traders');
    expect(html).not.toContain(OPP + '”');
    expect(html).toContain(`href="/quotations?opportunityId=${OPP}&amp;rows=10"`);
    expect(html).toContain('Clear filters');
  });

  it('keeps the plain empty states when no filter is set', async () => {
    mocks.listQuotationsPage.mockResolvedValue(page([], 0));
    expect(await render()).toContain('No quotations yet.');
    const scoped = await render({ opportunityId: OPP });
    expect(scoped).toContain('No quotations for this opportunity yet.');
    expect(scoped).not.toContain('Clear filters');
  });

  it('shows the no-access state for a 403 and an error with a reload link otherwise', async () => {
    mocks.listQuotationsPage.mockRejectedValue(new ApiError(403, 'no'));
    expect(await render()).toContain('Your roles do not include quotations');
    mocks.listQuotationsPage.mockRejectedValue(new ApiError(500, 'down'));
    const html = await render();
    expect(html).toContain('The quotations did not load');
    expect(html).toContain('Reload the quotations');
  });
});
