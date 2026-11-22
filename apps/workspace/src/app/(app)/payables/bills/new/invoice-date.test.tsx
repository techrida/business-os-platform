// I-34: the vendor bill form starts with the invoice date set to today in Kathmandu (the tenant's calendar), and
// the field stays editable. Renders the real page through the real API client (stubbed fetch).
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meAs, stubApi } from '@/test/api-fetch-stub';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ accessToken: 'tok', roles: ['accountant'] }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));

const { default: NewBillPage } = await import('./page');

beforeEach(() => {
  stubApi(() => ({
    '/v1/me': meAs('accountant'),
    '/v1/vendors': {
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          legalName: 'Dev Vendor Co',
          tradeName: null,
          kind: 'company',
          pan: '300000001',
          vatRegistered: true,
          country: 'NP',
          address: null,
          status: 'approved',
          version: 1,
          approvedAt: '2026-11-01T05:45:00.000Z',
        },
      ],
      total: 1,
    },
    '/v1/tax-codes': [{ id: '11111111-1111-4111-8111-111111111111', label: 'VAT 13%' }],
    '/v1/withholding-codes': [],
    '/v1/expense-accounts': [
      {
        id: '33333333-3333-4333-8333-333333333333',
        code: '5100',
        name: 'Office supplies',
        status: 'active',
        retiredAt: null,
      },
    ],
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const render = async () =>
  renderToStaticMarkup(await NewBillPage({ searchParams: Promise.resolve({}) }));

/** The value the form will submit for the invoice date. */
const invoiceDateOf = (html: string) => /<input[^>]*name="invoiceDate"[^>]*>/.exec(html)?.[0] ?? '';

describe('bill invoice date default (I-34)', () => {
  it("starts at today's date in Kathmandu, also when it is already tomorrow there", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 20:00 UTC on 19 Nov is 01:45 on 20 Nov in Kathmandu.
    vi.setSystemTime(new Date('2026-11-19T20:00:00Z'));
    const html = await render();
    const input = invoiceDateOf(html);
    expect(input).toContain('value="2026-11-20"');
  });

  it('stays editable: the field is neither read-only nor disabled', async () => {
    const input = invoiceDateOf(await render());
    expect(input).not.toBe('');
    expect(input).not.toMatch(/readonly|disabled/i);
  });
});
