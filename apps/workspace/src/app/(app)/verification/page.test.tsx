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
