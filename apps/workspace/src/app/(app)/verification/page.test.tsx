import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  listVerificationCasePage: vi.fn(),
  getCustomer: vi.fn(),
  requireStaffSession: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/customers/api', () => ({
  listVerificationCasePage: mocks.listVerificationCasePage,
  getCustomer: mocks.getCustomer,
}));
// The filter bar is a client component that needs the app router; it has its own test.
vi.mock('./verification-filters', () => ({ VerificationFilters: () => null }));

import VerificationQueuePage from './page';

async function render(params: Record<string, string | string[]> = {}) {
  const page = await VerificationQueuePage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(page);
}
const hrefOf = (html: string, text: string) =>
  html.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${text}</a>`))?.[1]?.replaceAll('&amp;', '&');

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 't', roles: [] });
  mocks.getCustomer.mockReset();
  mocks.listVerificationCasePage.mockReset().mockResolvedValue({ items: [], total: 0 });
});

it('lists the cases awaiting review when the URL names no status', async () => {
  const html = await render();
  expect(mocks.listVerificationCasePage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ status: ['submitted'] }),
  );
  expect(html).toContain('Nothing is waiting for review.');
  expect(hrefOf(html, 'Show all cases')).toBe('/verification?status=all');
});

it('lists every case for status=all, distinct from no param', async () => {
  const html = await render({ status: 'all' });
  const query: unknown = mocks.listVerificationCasePage.mock.calls[0]?.[1];
  expect(query).not.toHaveProperty('status');
  expect(html).toContain('No verification cases yet.');
});

it('clears a search on the default queue to every case, not back to the default', async () => {
  const html = await render({ q: 'acme', rows: '50' });
  expect(mocks.listVerificationCasePage).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ q: 'acme', status: ['submitted'] }),
  );
  expect(html).toContain('No cases match.');
  expect(hrefOf(html, 'Clear filters')).toBe('/verification?rows=50&status=all');
});

// The verification queue as pmo (audit #8): each row is named from the case list itself, customer and vendor alike,
// with no customer lookup per row (pmo has no vendor.read, and the old per-row customer read never named vendors).
const CUSTOMER_PARTY = '11111111-1111-4111-8111-111111111111';
const VENDOR_PARTY = '22222222-2222-4222-8222-222222222222';

const kase = (over: { n?: number } & Record<string, unknown>) => ({
  id: `33333333-3333-4333-8333-33333333333${over.n ?? 1}`,
  partyId: CUSTOMER_PARTY,
  partyKind: 'customer',
  status: 'submitted',
  checklist: [],
  reviewedBy: null,
  decidedAt: null,
  decisionNote: null,
  version: 1,
  ...over,
});

it('names customer and vendor cases from the list, without reading any customer', async () => {
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['pmo'] });
  mocks.getCustomer.mockRejectedValue(new Error('the queue must not read customers'));
  mocks.listVerificationCasePage.mockResolvedValue({
    items: [
      kase({ n: 1, partyName: 'Himalayan Traders Pvt. Ltd.', partyNumber: 'CUS-00042' }),
      kase({
        n: 2,
        partyId: VENDOR_PARTY,
        partyKind: 'vendor',
        partyName: 'Everest Supplies',
        partyNumber: null,
      }),
      kase({ n: 3, partyName: null, partyNumber: null }),
    ],
    total: 3,
  });
  const text = (await render()).replace(/<[^>]*>/g, ' ');

  expect(text).toContain('Himalayan Traders Pvt. Ltd.');
  expect(text).toContain('CUS-00042');
  expect(text).toContain('Everest Supplies');
  expect(text).toContain('Customer name unavailable');
  expect(mocks.getCustomer).not.toHaveBeenCalled();
  // No raw party ids in the visible text.
  expect(text).not.toContain(CUSTOMER_PARTY);
  expect(text).not.toContain(VENDOR_PARTY);
});
