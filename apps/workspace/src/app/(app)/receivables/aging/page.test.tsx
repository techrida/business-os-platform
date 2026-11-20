import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { agingReport, agingRow, CUSTOMER_ID, OTHER_CUSTOMER_ID } from '../_lib/fixtures';
import ReceivablesAgingPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getAging: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
// The live grants come from GET /v1/me; when it fails the page falls back to the role defaults.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: mocks.getMe,
}));
vi.mock('@/lib/api-receivables', () => ({ getAging: mocks.getAging }));

async function render(): Promise<string> {
  return renderToStaticMarkup(await ReceivablesAgingPage());
}

const ZERO = { current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d91_plus: '0.00' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.getMe.mockRejectedValue(new Error('down'));
});

/** The live grants `/v1/me` reports, each at `all`. */
const liveGrants = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('receivables aging', () => {
  it('shows each bucket as the server returned it, in lakh grouping, with a link to the statement', async () => {
    mocks.getAging.mockResolvedValue(agingReport());
    const html = await render();
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).toContain('NPR 1,00,000.00');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('NPR 7.00');
    expect(html).toContain(`href="/receivables/customers/${CUSTOMER_ID}"`);
    for (const label of [
      'Not yet due',
      '1 to 30 days',
      '31 to 60 days',
      '61 to 90 days',
      'Over 90 days',
    ]) {
      expect(html).toContain(label);
    }
    expect(mocks.getAging).toHaveBeenCalledTimes(1);
  });

  it('adds nothing up: the row total and the currency total are the server strings, not sums', async () => {
    // The row's buckets sum to 3,50,007.00 but the server says 9,99,999.00; the currency total says
    // 8,88,888.88. Anything computed client-side would show other numbers.
    mocks.getAging.mockResolvedValue(agingReport());
    const html = await render();
    expect(html).toContain('NPR 9,99,999.00');
    expect(html).not.toContain('3,50,007.00');
    expect(html).toContain('NPR 8,88,888.88');
    expect(html).toContain('NPR 1,23,456.00');
    expect(html).toContain('NPR 6,54,321.00');
  });

  it('shows a total card and a card per bucket, as server strings, per currency', async () => {
    mocks.getAging.mockResolvedValue(
      agingReport({
        totals: [
          {
            currency: 'NPR',
            buckets: { ...ZERO, current: '123456.00', d1_30: '654321.00', d91_plus: '1.00' },
            totalOpen: '888888.88',
          },
          {
            currency: 'USD',
            buckets: { ...ZERO, d31_60: '40.00', d61_90: '2.50' },
            totalOpen: '99.99',
          },
        ],
      }),
    );
    const html = await render();
    const card = (label: string, value: string) =>
      new RegExp(`${label}</dt><dd[^>]*><span[^>]*>${value.replace(/[.]/g, '\\.')}<`);
    const npr = /aria-label="Open balances in NPR".*?<\/section>/s.exec(html)?.[0] ?? '';
    const usd = /aria-label="Open balances in USD".*?<\/section>/s.exec(html)?.[0] ?? '';
    expect(npr).toMatch(card('Total open', 'NPR 8,88,888.88'));
    expect(npr).toMatch(card('Not yet due', 'NPR 1,23,456.00'));
    expect(npr).toMatch(card('1 to 30 days', 'NPR 6,54,321.00'));
    expect(npr).toMatch(card('31 to 60 days', 'NPR 0.00'));
    expect(npr).toMatch(card('61 to 90 days', 'NPR 0.00'));
    expect(npr).toMatch(card('Over 90 days', 'NPR 1.00'));
    // The other currency keeps its own cards; nothing is merged or added across currencies.
    expect(usd).toMatch(card('Total open', 'USD 99.99'));
    expect(usd).toMatch(card('31 to 60 days', 'USD 40.00'));
    expect(usd).toMatch(card('61 to 90 days', 'USD 2.50'));
    expect(html.match(/<dt[^>]*>Total open<\/dt>/g)).toHaveLength(2);
    // NPR 8,88,888.88 + USD 99.99 must never appear as one figure.
    expect(html).not.toContain('8,88,988.87');
  });

  it('shows no cards when no currency has a total', async () => {
    mocks.getAging.mockResolvedValue(agingReport({ totals: [] }));
    expect(await render()).not.toContain('Open balances in');
  });

  it('does not add the rows of two customers into a total of its own', async () => {
    mocks.getAging.mockResolvedValue(
      agingReport({
        rows: [
          agingRow({ totalOpen: '100.00' }),
          agingRow({
            customerId: OTHER_CUSTOMER_ID,
            customerName: 'Second Co',
            totalOpen: '200.00',
          }),
        ],
        totals: [{ currency: 'NPR', buckets: ZERO, totalOpen: '777.00' }],
      }),
    );
    const html = await render();
    expect(html).toContain('NPR 777.00');
    expect(html).not.toContain('NPR 300.00');
  });

  it('keeps rows in server order, one per customer and currency', async () => {
    mocks.getAging.mockResolvedValue(
      agingReport({
        rows: [
          agingRow({ customerName: 'Zeta Traders', totalOpen: '5.00' }),
          agingRow({ customerName: 'Zeta Traders', currency: 'USD', totalOpen: '6.00' }),
          agingRow({ customerId: OTHER_CUSTOMER_ID, customerName: 'Alpha Traders' }),
        ],
        totals: [],
      }),
    );
    const html = await render();
    expect(html.indexOf('Zeta Traders')).toBeLessThan(html.indexOf('Alpha Traders'));
    expect(html).toContain('NPR 5.00');
    expect(html).toContain('USD 6.00');
    expect(html.match(/Zeta Traders/g)).toHaveLength(2);
  });

  it('shows the asOf date from the response and never today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-03-03T06:00:00Z'));
    mocks.getAging.mockResolvedValue(agingReport({ asOf: '2026-11-09' }));
    const html = await render();
    expect(html).toContain('09 Nov 2026');
    expect(html).toContain('dateTime="2026-11-09"');
    expect(html).not.toContain('2031');
    expect(html).not.toContain('3 Mar');
  });

  it('keeps the asOf date and says nothing is open when there are no rows', async () => {
    mocks.getAging.mockResolvedValue(agingReport({ rows: [], totals: [] }));
    const html = await render();
    expect(html).toContain('No open receivables.');
    expect(html).toContain('09 Nov 2026');
    expect(html).not.toContain('<table');
  });

  it('still shows a currency total that has no rows, and rows that have no total', async () => {
    mocks.getAging.mockResolvedValue(agingReport({ rows: [] }));
    expect(await render()).toContain('NPR 8,88,888.88');
    mocks.getAging.mockResolvedValue(agingReport({ totals: [] }));
    const html = await render();
    expect(html).toContain('NPR 9,99,999.00');
    expect(html).not.toContain('Total NPR');
  });

  it('says in words that the roles lack receivables on a 403 from the API', async () => {
    mocks.getAging.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include receivables');
    expect(html).not.toContain('Reload the aging report');
  });

  it('does not call the API at all for a role without ar.read', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    const html = await render();
    expect(html).toContain('Your roles do not include receivables');
    expect(mocks.getAging).not.toHaveBeenCalled();
  });

  it('opens the report for a role whose saved grants add ar.read, though its defaults lack it', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    mocks.getMe.mockResolvedValue(liveGrants('customer.read', 'ar.read'));
    mocks.getAging.mockResolvedValue(agingReport());
    const html = await render();
    expect(mocks.getAging).toHaveBeenCalledTimes(1);
    expect(html).not.toContain('Your roles do not include receivables');
  });

  it('closes the report for a role whose saved grants removed ar.read, though its defaults hold it', async () => {
    mocks.getMe.mockResolvedValue(liveGrants('customer.read'));
    const html = await render();
    expect(html).toContain('Your roles do not include receivables');
    expect(mocks.getAging).not.toHaveBeenCalled();
  });

  it('offers a reload on an error, and on an invalid response', async () => {
    mocks.getAging.mockRejectedValue(
      new ApiError(502, 'GET /v1/receivables/aging returned an invalid body'),
    );
    const html = await render();
    expect(html).toContain('The aging report did not load');
    expect(html).toContain('Reload the aging report');
  });

  it('keeps a very long customer name inside a wrapping cell', async () => {
    mocks.getAging.mockResolvedValue(
      agingReport({ rows: [agingRow({ customerName: 'N'.repeat(400) })] }),
    );
    const html = await render();
    expect(html).toContain('N'.repeat(400));
    expect(html).toMatch(/class="[^"]*customer/);
  });
});
