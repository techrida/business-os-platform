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

  it('offers Edit only when the list capability permits it', async () => {
    mocks.listQuotations.mockResolvedValue([
      { ...item, status: 'returned' },
      { ...item, id: OPP, number: 'QT-2082-0042', status: 'returned', canEdit: false },
    ]);

    const html = await render();
    expect(html).toContain(`href="/quotations/${Q1}/edit" aria-label="Edit QT-2082-0001"`);
    expect(html).not.toContain(`href="/quotations/${OPP}/edit"`);
    expect(html).toContain(`href="/quotations/${OPP}" aria-label="View QT-2082-0042"`);
  });

  it('paginates matching rows and carries the search and active filters onward', async () => {
    mocks.listQuotations.mockResolvedValue([
      ...Array.from({ length: 7 }, (_, index) => ({
        ...item,
        id: `quotation-${index + 1}`,
        number: `QT-2082-000${index + 1}`,
      })),
      { ...item, id: 'other', customerName: 'Other organization', number: 'QT-2082-0099' },
    ]);

    const html = await render({ opportunityId: OPP, status: 'draft', q: 'HIMAL', page: '2' });

    expect(html).toContain('Showing 6–7 of 7');
    expect(html).toContain('QT-2082-0006');
    expect(html).not.toContain('QT-2082-0001');
    expect(html).not.toContain('QT-2082-0099');
    expect(html).toContain(`href="/quotations?opportunityId=${OPP}&amp;status=draft&amp;q=HIMAL"`);
  });

  it('shows status totals only for the unfiltered list, never for a filtered or scoped one', async () => {
    mocks.listQuotations.mockResolvedValue([
      item,
      { ...item, id: 'q-sent', number: 'QT-2082-0002', status: 'sent', canEdit: false },
    ]);
    const all = await render();
    expect(all).toContain('aria-label="Quotation totals by status"');
    for (const query of [{ opportunityId: OPP }, { status: 'sent' }, { q: 'HIMAL' }]) {
      expect(await render(query)).not.toContain('Quotation totals by status');
    }
  });

  it('ignores an opportunityId that is not a UUID', async () => {
    await render({ opportunityId: '../x' });
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), {});
  });
});
