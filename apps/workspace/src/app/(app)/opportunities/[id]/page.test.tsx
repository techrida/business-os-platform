import type { QuotationListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import OpportunityPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getOpportunity: vi.fn(),
  listActivities: vi.fn(),
  listLeadOwners: vi.fn(),
  getCustomer: vi.fn(),
  listQuotations: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/crm/crm-api', () => ({
  getOpportunity: mocks.getOpportunity,
  listActivities: mocks.listActivities,
  listLeadOwners: mocks.listLeadOwners,
}));
vi.mock('@/components/p2/customers/api', () => ({ getCustomer: mocks.getCustomer }));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));
vi.mock('../../activities/actions', () => ({ logActivityAction: vi.fn() }));
vi.mock('../actions', () => ({ moveOpportunityStageAction: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const OPP = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const Q1 = '55555555-5555-4555-8555-555555555551';
const Q2 = '55555555-5555-4555-8555-555555555552';
const WHEN = '2026-11-08T05:45:00.000Z';

const opportunity = (stage = 'qualified') => ({
  id: OPP,
  number: 'DEAL-0001',
  name: 'Bridge works',
  customerId: CUSTOMER,
  contactId: null,
  leadId: null,
  ownerUserId: null,
  stage,
  stageReason: null,
  stageNote: null,
  value: null,
  currency: 'NPR',
  probability: null,
  expectedClose: null,
  wonQuotationVersionId: null,
  version: 1,
  createdAt: WHEN,
  updatedAt: WHEN,
});

const quote = (id: string, over: Partial<QuotationListItem> = {}) =>
  ({
    id,
    number: `QT-${id.slice(-1)}`,
    currency: 'NPR',
    total: '12500.00',
    validUntil: '2026-11-30',
    status: 'draft',
    canEdit: true,
    ...over,
  }) as QuotationListItem;

async function render(): Promise<string> {
  return renderToStaticMarkup(await OpportunityPage({ params: Promise.resolve({ id: OPP }) }));
}

/** Every link-button in the page header, as [label, href]. */
function headerLinks(html: string): [string, string][] {
  return [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => [m[2] ?? '', (m[1] ?? '').replaceAll('&amp;', '&')] as [string, string])
    .filter(([label]) => /quotation|draft/i.test(label));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: ['sales'] });
  mocks.getOpportunity.mockReset().mockResolvedValue(opportunity());
  mocks.listActivities.mockReset().mockResolvedValue([]);
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  mocks.getCustomer.mockReset().mockResolvedValue(null);
  mocks.listQuotations.mockReset().mockResolvedValue([]);
});

describe('opportunity quotation actions (demo feedback: New quotation made four quotations)', () => {
  it("asks the API only for this opportunity's quotations", async () => {
    await render();
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), { opportunityId: OPP });
  });

  it('offers New quotation when there is no draft to resume', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    expect(headerLinks(await render())).toEqual([
      ['View quotations', `/quotations?opportunityId=${OPP}`],
      ['New quotation', `/quotations/new?opportunityId=${OPP}`],
    ]);
  });

  it('offers Edit quotation, and no New quotation, when one draft can be resumed', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'returned' })]);
    const html = await render();
    expect(headerLinks(html)).toEqual([
      ['View quotations', `/quotations?opportunityId=${OPP}`],
      ['Edit quotation', `/quotations/${Q1}/edit`],
    ]);
    expect(html).toContain('aria-label="Edit quotation QT-1"');
  });

  it('sends the person to the list to choose when several drafts can be edited', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1), quote(Q2)]);
    expect(headerLinks(await render())).toEqual([
      ['New quotation', `/quotations/new?opportunityId=${OPP}&another=1`],
      ['Choose a draft (2)', `/quotations?opportunityId=${OPP}`],
    ]);
  });

  it('falls back to New quotation when the list does not load', async () => {
    mocks.listQuotations.mockRejectedValue(new ApiError(500, 'down'));
    expect(headerLinks(await render())).toContainEqual([
      'New quotation',
      `/quotations/new?opportunityId=${OPP}`,
    ]);
  });

  it('offers no New quotation on a won opportunity, but still resumes a draft', async () => {
    mocks.getOpportunity.mockResolvedValue(opportunity('won'));
    expect(headerLinks(await render()).map(([label]) => label)).toEqual(['View quotations']);
    mocks.listQuotations.mockResolvedValue([quote(Q1)]);
    expect(headerLinks(await render()).map(([label]) => label)).toEqual([
      'View quotations',
      'Edit quotation',
    ]);
  });

  it('links associated quotations and highlights the accepted version that won the deal', async () => {
    mocks.getOpportunity.mockResolvedValue({
      ...opportunity('won'),
      wonQuotationVersionId: Q1,
    });
    mocks.listQuotations.mockResolvedValue([
      quote(Q1, { currentVersionId: Q1, status: 'accepted', canEdit: false }),
      quote(Q2, { currentVersionId: Q2, status: 'sent', canEdit: false }),
    ]);

    const html = await render();
    expect(html).toContain('<caption class="sr-only">Opportunity quotations</caption>');
    expect(html).toContain(`href="/quotations/${Q1}">QT-1</a>`);
    expect(html).toContain(`href="/quotations/${Q2}">QT-2</a>`);
    expect(html).toContain('data-accepted="true"');
    expect(html).not.toContain('name="stage"');
  });
});
