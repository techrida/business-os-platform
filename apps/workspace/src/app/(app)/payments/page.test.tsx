import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { listItem } from './_lib/fixtures';
import PaymentsPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ requireStaffSession: vi.fn(), listPayments: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-receivables', () => ({ listPayments: mocks.listPayments }));

async function render(status?: string): Promise<string> {
  const element = await PaymentsPage({
    searchParams: Promise.resolve(status === undefined ? {} : { status }),
  });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
});

describe('payments list', () => {
  it('shows rows with lakh-grouped money, a status badge in words and a link to the detail', async () => {
    mocks.listPayments.mockResolvedValue([
      listItem(),
      listItem({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'verified',
        number: 'RCPT-2083/84-00001',
        unallocatedAmount: '250000.00',
      }),
    ]);
    const html = await render();
    expect(html).toContain('NPR 10,00,000.00');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('Awaiting verification');
    expect(html).toContain('RCPT-2083/84-00001');
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).toContain('href="/payments/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('2 payments');
  });

  it('passes a valid status filter to the API and ignores an invalid one', async () => {
    mocks.listPayments.mockResolvedValue([]);
    await render('verified');
    expect(mocks.listPayments).toHaveBeenLastCalledWith(expect.anything(), 'verified');
    await render('bogus');
    expect(mocks.listPayments).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });

  it('has an empty state, and a different one when a filter is on', async () => {
    mocks.listPayments.mockResolvedValue([]);
    expect(await render()).toContain('No payments yet.');
    const filtered = await render('rejected');
    expect(filtered).toContain('No payments are rejected.');
    expect(filtered).toContain('Show all payments');
  });

  it('says in words that the roles lack payments on a 403', async () => {
    mocks.listPayments.mockRejectedValue(new ApiError(403, 'no'));
    const html = await render();
    expect(html).toContain('Your roles do not include payments');
    expect(html).not.toContain('Reload the payments');
  });

  it('offers a reload on an error', async () => {
    mocks.listPayments.mockRejectedValue(new ApiError(500, 'boom'));
    const html = await render();
    expect(html).toContain('The payments did not load');
    expect(html).toContain('Reload the payments');
  });

  it('keeps a very long customer name inside a wrapping cell', async () => {
    mocks.listPayments.mockResolvedValue([listItem({ customerName: 'N'.repeat(400) })]);
    const html = await render();
    expect(html).toContain('N'.repeat(400));
    expect(html).toMatch(/class="[^"]*customer/);
  });
});
