// The verification queue as pmo (audit #8): each row is named from the case list itself, customer and vendor alike,
// with no customer lookup per row (pmo has no vendor.read, and the old per-row customer read never named vendors).
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listVerificationCases: vi.fn(),
  getCustomer: vi.fn(() => Promise.reject(new Error('the queue must not read customers'))),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn().mockResolvedValue({ roles: ['pmo'], accessToken: 't' }),
}));
vi.mock('@/components/p2/customers/api', () => api);

const { default: VerificationQueuePage } = await import('./page');

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

beforeEach(() => vi.clearAllMocks());

it('names customer and vendor cases from the list, without reading any customer', async () => {
  api.listVerificationCases.mockResolvedValue({
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
  const html = renderToStaticMarkup(
    await VerificationQueuePage({ searchParams: Promise.resolve({}) }),
  );
  const text = html.replace(/<[^>]*>/g, ' ');

  expect(text).toContain('Himalayan Traders Pvt. Ltd.');
  expect(text).toContain('CUS-00042');
  expect(text).toContain('Everest Supplies');
  expect(text).toContain('Customer name unavailable');
  expect(api.getCustomer).not.toHaveBeenCalled();
  // No raw party ids in the visible text.
  expect(text).not.toContain(CUSTOMER_PARTY);
  expect(text).not.toContain(VENDOR_PARTY);
});
