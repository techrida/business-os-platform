// @vitest-environment jsdom
import { LeadDtoSchema, type LeadDto } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LeadsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getPermissionCheck: vi.fn(),
  listLeadsPage: vi.fn(),
  getLeadSummary: vi.fn(),
  listLeadOwners: vi.fn(),
  ownerFilterNames: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/display-settings', () => ({ getNumberSystems: vi.fn(() => Promise.resolve({})) }));
vi.mock('@/lib/live-permissions', () => ({ getPermissionCheck: mocks.getPermissionCheck }));
vi.mock('@/components/p2/crm/leads-api', () => ({
  listLeadsPage: mocks.listLeadsPage,
  getLeadSummary: mocks.getLeadSummary,
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  listLeadOwners: mocks.listLeadOwners,
  ownerFilterNames: mocks.ownerFilterNames,
}));
vi.mock('./actions', () => ({ moveLeadStageAction: vi.fn(), updateLeadStageAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/leads',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const WHEN = '2026-11-08T05:45:00.000Z';

/** A list row as the API sends it, through the contract's own schema (optional fields omitted). */
const lead = (over: Partial<LeadDto> = {}): LeadDto =>
  LeadDtoSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    number: 'LD-2026-0019',
    title: 'Inventory and dispatch automation',
    source: 'website',
    campaign: null,
    ownerUserId: null,
    ownerName: null,
    companyName: 'Himalayan Agro Foods Pvt. Ltd.',
    contactName: 'Sunita Shrestha',
    email: null,
    country: 'NP',
    address: null,
    phones: [],
    customerId: null,
    contactId: null,
    requirement: null,
    expectedValue: null,
    currency: 'NPR',
    probability: null,
    expectedClose: null,
    nextFollowUpAt: null,
    stage: 'new',
    stageReason: null,
    lostReason: null,
    stageNote: null,
    convertedOpportunityId: null,
    version: 1,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  });

async function render(params: Record<string, string> = {}): Promise<Document> {
  const html = renderToStaticMarkup(await LeadsPage({ searchParams: Promise.resolve(params) }));
  return new DOMParser().parseFromString(html, 'text/html');
}

const addLeadLinks = (doc: Document) => doc.querySelectorAll('a[href="/leads/new"]');

/** Grants `held` only, as `getPermissionCheck` answers from the live permissions. */
const grants = (...held: string[]) =>
  mocks.getPermissionCheck.mockResolvedValue((p: string) => held.includes(p));

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok', roles: [] });
  mocks.getPermissionCheck.mockReset();
  mocks.listLeadsPage.mockReset().mockResolvedValue({ items: [lead()], total: 1 });
  mocks.getLeadSummary.mockReset().mockResolvedValue(null);
  mocks.listLeadOwners.mockReset().mockResolvedValue([]);
  mocks.ownerFilterNames.mockReset().mockResolvedValue(new Map());
});

describe('Add lead (TR-Q3)', () => {
  it('is offered to people who may create leads', async () => {
    grants('crm.lead.read', 'crm.lead.write');
    expect(addLeadLinks(await render())).toHaveLength(1);
  });

  it('is hidden from people who may only read leads, on the list and its empty state', async () => {
    grants('crm.lead.read');
    let doc = await render();
    expect(addLeadLinks(doc)).toHaveLength(0);
    expect(doc.body.textContent).not.toContain('Add lead');

    mocks.listLeadsPage.mockResolvedValue({ items: [], total: 0 });
    doc = await render();
    expect(doc.body.textContent).toContain('No leads yet');
    expect(addLeadLinks(doc)).toHaveLength(0);
  });

  it('is hidden on the load-problem page too', async () => {
    grants('crm.lead.read');
    mocks.listLeadsPage.mockRejectedValue(new Error('down'));
    const doc = await render();
    expect(addLeadLinks(doc)).toHaveLength(0);
  });

  it('asks for the permission check with the signed-in session', async () => {
    grants('crm.lead.write');
    await render();
    expect(mocks.getPermissionCheck).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'tok' }),
    );
  });
});
