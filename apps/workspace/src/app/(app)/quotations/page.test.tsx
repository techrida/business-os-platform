import type { QuotationListItem } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuotationsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listQuotations: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));

const OPP = '11111111-1111-4111-8111-111111111111';
const Q1 = '55555555-5555-4555-8555-555555555551';

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

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await QuotationsPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  mocks.listQuotations.mockReset().mockResolvedValue([item]);
});

describe('quotations list', () => {
  it('lists everything the caller may read without an opportunity filter', async () => {
    const html = await render();
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), {});
    expect(html).toContain('<h1');
    expect(html).not.toContain('another=1');
    expect(html).not.toContain('name="opportunityId"');
  });

  it('filters by opportunity (demo feedback: View quotations ignored it), keeping it through the status filter', async () => {
    const html = await render({ opportunityId: OPP, status: 'draft' });
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), {
      status: 'draft',
      opportunityId: OPP,
    });
    expect(html).toContain('Quotations for this opportunity');
    expect(html).toContain(`<input type="hidden" name="opportunityId" value="${OPP}"/>`);
    // Starting another quotation from here is deliberate, so the New page does not resume a draft.
    expect(html).toContain(`href="/quotations/new?opportunityId=${OPP}&amp;another=1"`);
    expect(html).toContain(`href="/opportunities/${OPP}"`);
  });

  it('ignores an opportunityId that is not a UUID', async () => {
    await render({ opportunityId: '../x' });
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), {});
  });
});
