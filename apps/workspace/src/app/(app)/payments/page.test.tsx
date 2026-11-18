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
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
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

  it('paginates matching receipts while preserving the search and status', async () => {
    mocks.listPayments.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        listItem({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          number: `RCPT-${i}`,
          status: 'verified',
          customerName: i === 7 ? 'Other customer' : 'Acme Ltd',
        }),
      ),
    );
    const html = renderToStaticMarkup(
      await PaymentsPage({
        searchParams: Promise.resolve({ status: 'verified', q: 'ACME', page: '2' }),
      }),
    );
    expect(mocks.listPayments).toHaveBeenCalledWith(expect.anything(), 'verified');
    expect(html).toContain('Showing 6–7 of 7 payments');
    expect(html).toContain('RCPT-5');
    expect(html).not.toContain('RCPT-4');
    expect(html).not.toContain('Other customer');
    expect(html).toContain('href="/payments?status=verified&amp;q=ACME"');
  });

  it('links to Record payment for a role with payment.record, with rows and when empty', async () => {
    mocks.listPayments.mockResolvedValue([listItem()]);
    const html = await render();
    expect(html).toContain('href="/payments/new"');
    expect(html).toContain('Record payment');
    mocks.listPayments.mockResolvedValue([]);
    expect(await render()).toContain('href="/payments/new"');
  });

  it('hides the Record payment link from roles without payment.record', async () => {
    mocks.listPayments.mockResolvedValue([listItem()]);
    for (const roles of [[], ['management'], ['sales']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const html = await render();
      expect(html).not.toContain('/payments/new');
      expect(html).not.toContain('Record payment');
    }
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
