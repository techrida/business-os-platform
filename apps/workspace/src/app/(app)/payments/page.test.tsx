import type { MoneyTotals } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { listItem } from './_lib/fixtures';
import PaymentsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listPaymentsPage: vi.fn(),
  getPaymentsSummary: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  getMe: mocks.getMe,
}));
vi.mock('@/lib/api-receivables', () => ({
  listPaymentsPage: mocks.listPaymentsPage,
  getPaymentsSummary: mocks.getPaymentsSummary,
}));
// The filter toolbar is a client component that reads the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/payments',
  useSearchParams: () => new URLSearchParams(),
}));

/** GET /v1/me with the live grants Settings > Access gives the caller's roles. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

const SUMMARY = {
  total: 9,
  byStatus: { submitted: 3, verified: 4, rejected: 2, withdrawn: 0, reversed: 0 },
};
const page = (
  items: ReturnType<typeof listItem>[],
  total = items.length,
  totals: MoneyTotals | null = null,
) => ({ items, total, totals });

async function render(search: Record<string, string | string[]> = {}): Promise<string> {
  return renderToStaticMarkup(await PaymentsPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.listPaymentsPage.mockResolvedValue(page([listItem()]));
  mocks.getPaymentsSummary.mockResolvedValue(SUMMARY);
  // Without a live answer the action buttons hide (the sidebar keeps the role defaults).
  mocks.getMe.mockRejectedValue(new Error('GET /v1/me failed'));
});

describe('payments list', () => {
  it('shows rows with lakh-grouped money, a status badge in words and a link to the detail', async () => {
    mocks.listPaymentsPage.mockResolvedValue(
      page([
        listItem(),
        listItem({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'verified',
          number: 'RCPT-2083/84-00001',
          unallocatedAmount: '250000.00',
        }),
      ]),
    );
    const html = await render();
    expect(html).toContain('NPR 10,00,000.00');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('Awaiting verification');
    expect(html).toContain('RCPT-2083/84-00001');
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).toContain('href="/payments/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('2 payments');
  });

  it('ends each row with Status and a View action, named even before numbering', async () => {
    mocks.listPaymentsPage.mockResolvedValue(
      page([
        listItem(),
        listItem({
          id: '22222222-2222-4222-8222-222222222222',
          status: 'verified',
          number: 'RCPT-2083/84-00001',
        }),
      ]),
    );
    const html = await render();
    const headers = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual([
      'Receipt',
      'Customer',
      'Method',
      'Amount received',
      'Not yet allocated',
      'Received on',
      'Status',
      'Action',
    ]);
    // The status badge sits after the date, in the pinned trailing band.
    expect(html).toMatch(/<\/time><\/td><td [^>]*data-pinned=""[^>]*>.*?Awaiting verification/);
    const links = html.match(/<a [^>]*>/g) ?? [];
    const numbered = links.find((a) => a.includes('aria-label="View RCPT-2083/84-00001"'));
    expect(numbered).toContain('href="/payments/22222222-2222-4222-8222-222222222222"');
    const unnumbered = links.find(
      (a) =>
        a.includes('aria-label="View payment of ') &&
        a.includes(' from Himalayan Traders Pvt. Ltd. received '),
    );
    expect(unnumbered).toContain('href="/payments/11111111-1111-4111-8111-111111111111"');
  });

  it('takes the stat cards from the server counts, not from the rows on the page', async () => {
    const html = await render();
    expect(html).toMatch(/Total payments<\/dt><dd[^>]*>9</);
    expect(html).toMatch(/Awaiting verification<\/dt><dd[^>]*>3</);
    expect(html).toMatch(/Verified<\/dt><dd[^>]*>4</);
    expect(html).toMatch(/Rejected<\/dt><dd[^>]*>2</);
    expect(mocks.listPaymentsPage).toHaveBeenCalledTimes(1);
    expect(mocks.getPaymentsSummary).toHaveBeenCalledTimes(1);
  });

  it('reads a repeated status or method as several values and asks for one page', async () => {
    await render({ status: ['verified', 'rejected'], method: 'cash', q: ' acme ' });
    expect(mocks.listPaymentsPage).toHaveBeenCalledWith(expect.anything(), {
      status: ['verified', 'rejected'],
      method: ['cash'],
      q: 'acme',
      limit: 25,
      offset: 0,
    });
    expect(mocks.getPaymentsSummary.mock.calls[0]?.[1]).not.toHaveProperty('limit');
  });

  it.each([
    { status: 'bogus' },
    { method: 'card' },
    { status: ['x', 'y'] },
    { rows: '7' },
    { q: 'a' },
  ])('drops a bad value %j and asks for the unfiltered first page', async (search) => {
    await render(search);
    expect(mocks.listPaymentsPage).toHaveBeenCalledWith(expect.anything(), {
      status: [],
      method: [],
      q: undefined,
      limit: 25,
      offset: 0,
    });
  });

  it('keeps chosen values in the form, so a no-JavaScript submit repeats them, with no Apply button', async () => {
    const html = await render({ status: ['verified', 'rejected'], method: 'cash' });
    expect(html).toContain('<input type="hidden" name="status" value="verified"');
    expect(html).toContain('<input type="hidden" name="status" value="rejected"');
    expect(html).toContain('<input type="hidden" name="method" value="cash"');
    expect(html).not.toContain('Apply');
  });

  it('pages by the server total, keeps filters in the links and the rows choice', async () => {
    mocks.listPaymentsPage.mockResolvedValue(
      page(
        Array.from({ length: 5 }, (_, i) =>
          listItem({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
        ),
        55,
      ),
    );
    const html = await render({ status: 'verified', q: 'ACME', page: '3' });
    expect(mocks.listPaymentsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25, offset: 50, status: ['verified'], q: 'ACME' }),
    );
    expect(html).toContain('Showing 51–55 of 55');
    expect(html).toContain('href="/payments?status=verified&amp;q=ACME&amp;page=2"');
    expect(html).toContain('href="/payments?status=verified&amp;q=ACME&amp;rows=50"');
  });

  it('shows the last page when the asked-for page is past the end', async () => {
    mocks.listPaymentsPage
      .mockResolvedValueOnce(page([], 30))
      .mockResolvedValueOnce(page([listItem()], 30));
    const html = await render({ page: '9' });
    expect(mocks.listPaymentsPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 25, offset: 25 }),
    );
    expect(html).toContain('Showing 26–30 of 30');
  });

  it('links to Record payment for a role with payment.record, with rows and when empty', async () => {
    mocks.getMe.mockResolvedValue(liveGrants('payment.read', 'payment.record'));
    const html = await render();
    expect(html).toContain('href="/payments/new"');
    expect(html).toContain('Record payment');
    mocks.listPaymentsPage.mockResolvedValue(page([]));
    expect(await render()).toContain('href="/payments/new"');
  });

  it('hides the Record payment link when GET /v1/me fails, even for a role that normally records', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getMe.mockRejectedValue(new Error('GET /v1/me failed'));
    const html = await render();
    expect(html).not.toContain('/payments/new');
    expect(html).not.toContain('Record payment');
  });

  it('hides the Record payment link from roles without payment.record', async () => {
    for (const roles of [[], ['management'], ['sales']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const html = await render();
      expect(html).not.toContain('/payments/new');
      expect(html).not.toContain('Record payment');
    }
  });

  it('shows the Record payment link by the live grants, not the role defaults', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getMe.mockResolvedValue(liveGrants('payment.read', 'payment.record'));
    expect(await render()).toContain('href="/payments/new"');
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getMe.mockResolvedValue(liveGrants('payment.read'));
    expect(await render()).not.toContain('/payments/new');
  });

  it('has an empty state, and one that names the hiding filters with a way to clear them', async () => {
    mocks.listPaymentsPage.mockResolvedValue(page([]));
    expect(await render()).toContain('No payments yet.');
    const filtered = await render({
      status: ['rejected', 'withdrawn'],
      method: 'qr',
      q: 'zzz',
      rows: '50',
    });
    expect(filtered).toContain('No payments match these filters.');
    expect(filtered).toContain('Status: Rejected, Withdrawn');
    expect(filtered).toContain('Method: QR payment');
    expect(filtered).toContain('Search “zzz”');
    expect(filtered).toContain('href="/payments?rows=50"');
    expect(filtered).toContain('Clear filters');
  });

  it('still shows the table when only the counts fail', async () => {
    mocks.getPaymentsSummary.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).not.toContain('Payment summary');
  });

  it('says in words that the roles lack payments on a 403', async () => {
    mocks.listPaymentsPage.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include payments');
    expect(html).not.toContain('Reload the payments');
  });

  it('offers a reload on an error that keeps the filters', async () => {
    mocks.listPaymentsPage.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render({ status: ['verified', 'rejected'] });
    expect(html).toContain('The payments did not load');
    expect(html).toContain('href="/payments?status=verified&amp;status=rejected"');
  });

  it('keeps a very long customer name inside a wrapping cell', async () => {
    mocks.listPaymentsPage.mockResolvedValue(page([listItem({ customerName: 'N'.repeat(400) })]));
    const html = await render();
    expect(html).toContain('N'.repeat(400));
    expect(html).toMatch(/class="[^"]*customer/);
  });
});

describe('total row', () => {
  it('ends the table with the amounts received of every match, one row per currency', async () => {
    mocks.listPaymentsPage.mockResolvedValue(
      page([listItem()], 9, [
        { currency: 'NPR', amount: '2018180.00' },
        { currency: 'INR', amount: '500.00' },
      ]),
    );
    const foot = /<tfoot>.*<\/tfoot>/s.exec(await render())?.[0] ?? '';
    // Old code showed no total at all.
    expect(foot).toContain('Total, all pages · NPR');
    expect(foot).toContain('20,18,180.00');
    expect(foot).toContain('Total, all pages · INR');
    // Under "Amount received", the fourth column.
    expect(foot).toContain('colSpan="3"');
  });
});
