import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { getPaymentRequest } from '@/lib/api-payables';

import PaymentRequestPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn().mockResolvedValue({ roles: [] }) }));
// The caller's live grants (GET /v1/me); a test replaces them for an edited role.
const grants = vi.hoisted(() => ({
  live: new Map<string, string>([['payables.payment.request', 'all']]),
}));
vi.mock('@/lib/grants', () => ({
  getGrants: () => Promise.resolve(grants.live),
  hasGrant: (g: Map<string, string>, p: string) => g.has(p),
}));
vi.mock('../forms', () => ({ PaymentRequestCommand: () => null }));
vi.mock('@/lib/api-payables', () => ({
  listPaymentRequestItems: vi.fn().mockResolvedValue([]),
  getPaymentRequest: vi.fn().mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    number: 'PAY-0042',
    vendorPartyId: '22222222-2222-4222-8222-222222222222',
    fromBankAccountId: '33333333-3333-4333-8333-333333333333',
    bankLast4: '6789',
    totalAmount: '100.00',
    currency: 'NPR',
    status: 'draft',
    approvalRequestId: null,
    cancelReason: null,
    lines: [{ id: 'line-id', lineNo: 1, openItemId: 'open-item-id', amount: '100.00' }],
    vendorName: 'Himal Supplies Pvt Ltd',
    can: { readVendor: true },
  }),
}));

const render = async () =>
  renderToStaticMarkup(
    await PaymentRequestPage({
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
    }),
  );

it('shows product labels while preserving the vendor link and payment references', async () => {
  const html = await render();
  const text = html.replace(/<[^>]*>/g, '');
  expect(html).toContain('href="/vendors/22222222-2222-4222-8222-222222222222"');
  expect(text).toContain('Himal Supplies Pvt Ltd');
  expect(text).toContain('Selected paying account');
  expect(text).toContain('Bill 1 of 1');
  expect(text).toContain('PAY-0042');
  expect(text).toContain('Ending 6789');
  expect(text).not.toMatch(/22222222|33333333|open-item-id/);
  const accessibleAttributes = html.match(/\b(?:title|alt|aria-[\w-]+)=(?:"[^"]*"|'[^']*')/gi);
  expect(accessibleAttributes?.join(' ') ?? '').not.toMatch(/22222222|33333333|open-item-id/);
});

it('names the vendor without a link for a caller the vendor page would refuse (U18 #15)', async () => {
  const base = await getPaymentRequest({} as never, '11111111-1111-4111-8111-111111111111');
  vi.mocked(getPaymentRequest).mockResolvedValueOnce({ ...base, can: { readVendor: false } });
  const html = await render();
  const text = html.replace(/<[^>]*>/g, '');
  expect(text).toContain('Himal Supplies Pvt Ltd');
  expect(html).not.toContain('/vendors/');
  expect(text).not.toContain('View vendor');
});

// A Management approver an admin granted payables.payment.request opens the request their approval links to; the
// page reads the live grants, not the Management role's defaults (which hold no payment request grant).
const management = (extra: [string, string][] = []) =>
  new Map<string, string>([...Object.entries(DEFAULT_ROLE_PERMISSIONS.management), ...extra]);

it('opens for a Management approver granted payables.payment.request', async () => {
  vi.mocked(getPaymentRequest).mockClear();
  grants.live = management([['payables.payment.request', 'all']]);
  const text = (await render()).replace(/<[^>]*>/g, '');
  expect(text).not.toContain('Your roles do not include payment requests.');
  expect(text).toContain('PAY-0042');
  expect(getPaymentRequest).toHaveBeenCalledOnce();
});

it('refuses a Management approver without that grant, before reading the request', async () => {
  vi.mocked(getPaymentRequest).mockClear();
  grants.live = management();
  const text = (await render()).replace(/<[^>]*>/g, '');
  expect(text).toContain('Your roles do not include payment requests.');
  expect(text).not.toContain('PAY-0042');
  expect(text).not.toContain('Himal Supplies');
  expect(getPaymentRequest).not.toHaveBeenCalled();
});
