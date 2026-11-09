import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { CUSTOMER_ID } from '../_lib/fixtures';

import NewPaymentPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  listCustomers: vi.fn(),
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/customers/api', () => ({
  listCustomers: mocks.listCustomers,
  getCustomer: mocks.getCustomer,
}));
// The form's action is a server action; the page test never submits it.
vi.mock('./actions', () => ({ recordPaymentAction: vi.fn() }));

const OTHER_ID = '99999999-9999-4999-8999-999999999999';

function customer(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    number: 'CUS-0001',
    legalName: 'Himalayan Traders Pvt. Ltd.',
    panVatNo: null,
    industry: null,
    relationship: 'active',
    ownerUserId: null,
    defaultCurrency: 'NPR',
    address: {},
    mergedIntoId: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

async function render(query: { customerId?: string; q?: string } = {}): Promise<string> {
  return renderToStaticMarkup(await NewPaymentPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
  mocks.listCustomers.mockResolvedValue({ items: [customer()], total: 1 });
  mocks.getCustomer.mockRejectedValue(new ApiError(404, 'no'));
});

describe('record payment page', () => {
  it('shows the form with customers, the fields, proof and a hidden idempotency key', async () => {
    const html = await render();
    expect(html).toContain('Record payment');
    expect(html).toContain('Himalayan Traders Pvt. Ltd. (CUS-0001)');
    for (const label of [
      'Customer',
      'Currency',
      'Amount received',
      'Payment method',
      'Received on',
      'Bank reference',
      'Tax withheld',
      'Withholding code',
      'Add proof files',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/<input type="hidden" name="idempotencyKey" value="[0-9a-f-]{36}"\/>/);
    expect(html).toContain('type="file"');
    expect(html).toContain('Choose the customer first.');
    expect(html).not.toContain('Find a customer');
  });

  it('gives each render its own idempotency key', async () => {
    const key = (h: string) => /name="idempotencyKey" value="([^"]+)"/.exec(h)?.[1];
    expect(key(await render())).not.toBe(key(await render()));
  });

  it('preselects a customer named in the link and lets the file picker open', async () => {
    const html = await render({ customerId: CUSTOMER_ID });
    expect(html).toContain(`name="customerId" value="${CUSTOMER_ID}"`);
    expect(html).toContain('You can add several files at once.');
  });

  it('adds a linked customer the list did not return, and ignores one that is merged or unreadable', async () => {
    mocks.getCustomer.mockResolvedValue(customer({ id: OTHER_ID, legalName: 'Linked Co' }));
    expect(await render({ customerId: OTHER_ID })).toContain('Linked Co (CUS-0001)');
    mocks.getCustomer.mockResolvedValue(
      customer({ id: OTHER_ID, legalName: 'Merged Co', mergedIntoId: CUSTOMER_ID }),
    );
    expect(await render({ customerId: OTHER_ID })).not.toContain('Merged Co');
    mocks.getCustomer.mockRejectedValue(new ApiError(500, 'x'));
    expect(await render({ customerId: OTHER_ID })).toContain('Himalayan Traders');
  });

  it('leaves merged customers out of the picker', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [
        customer(),
        customer({ id: OTHER_ID, legalName: 'Old Co', mergedIntoId: CUSTOMER_ID }),
      ],
      total: 2,
    });
    expect(await render()).not.toContain('Old Co');
  });

  it('offers a search when the list is cut off, and passes the search text on', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: Array.from({ length: 100 }, (_, i) =>
        customer({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
      ),
      total: 240,
    });
    const html = await render();
    expect(html).toContain('Find a customer');
    expect(html).toContain('Showing the first 100');
    await render({ q: ' Himal ' });
    expect(mocks.listCustomers).toHaveBeenLastCalledWith(expect.anything(), {
      q: 'Himal',
      limit: 100,
    });
  });

  it('has an empty state, and a different one when a search finds nothing', async () => {
    mocks.listCustomers.mockResolvedValue({ items: [], total: 0 });
    const none = await render();
    expect(none).toContain('There are no customers yet.');
    expect(none).toContain('href="/customers/new"');
    expect(none).not.toContain('Record payment</button>');
    const searched = await render({ q: 'zzz' });
    expect(searched).toContain('No customers match that search.');
    expect(searched).toContain('Clear search');
  });

  it('says the roles lack customers on a 403, and offers a reload on another error', async () => {
    mocks.listCustomers.mockRejectedValue(new ApiError(403, 'no'));
    const denied = await render();
    expect(denied).toContain('Your roles do not include customers');
    expect(denied).not.toContain('Reload the form');
    mocks.listCustomers.mockRejectedValue(new ApiError(500, 'boom'));
    const failed = await render();
    expect(failed).toContain('The customers did not load');
    expect(failed).toContain('Reload the form');
  });

  it('is a plain notice, with no form and no customer lookup, for roles without payment.record', async () => {
    for (const roles of [[], ['management'], ['sales']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const html = await render();
      expect(html).toContain('Your roles do not include recording payments');
      expect(html).not.toContain('<form');
    }
    expect(mocks.listCustomers).not.toHaveBeenCalled();
  });

  it('keeps a very long customer name in the option text', async () => {
    mocks.listCustomers.mockResolvedValue({
      items: [customer({ legalName: 'N'.repeat(400) })],
      total: 1,
    });
    expect(await render()).toContain('N'.repeat(400));
  });

  it('returns here after sign-in, with the customer kept', async () => {
    await render({ customerId: CUSTOMER_ID });
    expect(mocks.requireStaffSession).toHaveBeenCalledWith(
      `/payments/new?customerId=${CUSTOMER_ID}`,
    );
  });
});
