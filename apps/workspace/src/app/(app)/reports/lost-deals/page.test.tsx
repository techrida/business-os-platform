import type { LostReasonReport } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import LostDealsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getLostReasonReport: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
// The live grants come from GET /v1/me; when it fails the page falls back to the role defaults.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: mocks.getMe,
}));
vi.mock('./load', () => ({ getLostReasonReport: mocks.getLostReasonReport }));

const PRICE_ID = '7d0f3c1e-1b2a-4c3d-8e4f-5a6b7c8d9e01';

function report(overrides: Partial<LostReasonReport> = {}): LostReasonReport {
  return {
    from: '2026-09',
    to: '2026-11',
    months: ['2026-09', '2026-10', '2026-11'],
    rows: [
      { reason: { id: PRICE_ID, label: 'Price', retired: false }, counts: [2, 0, 1], total: 3 },
      { reason: null, counts: [0, 1, 0], total: 1 },
    ],
    monthTotals: [2, 1, 1],
    total: 4,
    ...overrides,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await LostDealsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
  mocks.getMe.mockRejectedValue(new Error('down'));
});

describe('lost deals', () => {
  it('shows counts by reason and month with totals', async () => {
    mocks.getLostReasonReport.mockResolvedValue(report());
    const html = await render();
    expect(html).toContain('Lost deals');
    for (const label of ['Sep 2026', 'Oct 2026', 'Nov 2026', 'Price', 'No reason given', 'Total']) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/Price<\/td><td[^>]*>2<\/td><td[^>]*>0<\/td><td[^>]*>1<\/td><td[^>]*>3</);
    expect(html).toMatch(/>Total<\/th><td[^>]*>2<\/td><td[^>]*>1<\/td><td[^>]*>1<\/td><td[^>]*>4</);
    expect(html).not.toContain('No lost deals in this period.');
  });

  it('shows a plain empty state when nothing was lost', async () => {
    mocks.getLostReasonReport.mockResolvedValue(
      report({ rows: [], monthTotals: [0, 0, 0], total: 0 }),
    );
    const html = await render();
    expect(html).toContain('No lost deals in this period.');
    expect(html).not.toContain('<table');
  });

  it('tells a person without the deal read so, without fetching', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['procurement'] });
    const html = await render();
    expect(html).toContain('Your roles do not include opportunities');
    expect(mocks.getLostReasonReport).not.toHaveBeenCalled();
  });

  it('treats a 403 from the API as no access, and other failures as a reloadable error', async () => {
    mocks.getLostReasonReport.mockRejectedValueOnce(new ApiError(403, 'forbidden', undefined));
    expect(await render()).toContain('Your roles do not include opportunities');
    mocks.getLostReasonReport.mockRejectedValueOnce(new ApiError(500, 'boom', undefined));
    const html = await render();
    expect(html).toContain('Lost deals did not load');
    expect(html).toContain('Reload lost deals');
  });
});
