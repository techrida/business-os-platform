import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ roles: ['finance'] as string[] }));
const api = vi.hoisted(() => ({ listPaymentRequests: vi.fn(), getPaymentRequest: vi.fn() }));
vi.mock('@/lib/bff', () => ({ requireStaffSession: async () => session }));
vi.mock('@/lib/api-payables', () => api);
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('./actions', () => ({
  createPaymentRequestAction: vi.fn(),
  submitPaymentRequestAction: vi.fn(),
  cancelPaymentRequestAction: vi.fn(),
}));

const { default: ListPage } = await import('./page');
const { default: DetailPage } = await import('./[id]/page');
const { default: NewPage } = await import('./new/page');
const id = '11111111-1111-4111-8111-111111111111';
const record = {
  id,
  number: 'PAY-2083-0001',
  vendorPartyId: id,
  paymentType: 'settlement',
  purchaseOrderId: null,
  currency: 'NPR',
  totalAmount: '111500.00',
  fromBankAccountId: id,
  vendorBankAccountId: id,
  bankLast4: '1234',
  status: 'draft',
  requestedBy: id,
  approvalRequestId: null,
  cancelReason: null,
  version: 1,
  lines: [{ id, lineNo: 1, openItemId: id, amount: '111500.00' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['finance'];
  api.listPaymentRequests.mockResolvedValue([record]);
  api.getPaymentRequest.mockResolvedValue(record);
});

it('lists the server total and links to new and detail screens', async () => {
  const html = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('PAY-2083-0001');
  expect(html).toContain('/payables/payment-requests/new');
  expect(html).toContain(`/payables/payment-requests/${id}`);
  expect(html).toMatch(/does not send money|No money/i);
});

it('hides drafts actions from an approved request and shows its bank snapshot and approval', async () => {
  api.getPaymentRequest.mockResolvedValue({ ...record, status: 'approved', approvalRequestId: id });
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('1234');
  expect(html).toContain(`/inbox/${id}`);
  expect(html).not.toContain('Cancel draft');
  expect(html).not.toContain('Submit for approval');
});

it('offers submit and cancel only for a draft', async () => {
  const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ id }) }));
  expect(html).toContain('Submit for approval');
  expect(html).toContain('Cancel draft');
});

it('shows controlled entry fields for the vendor, source account and bill items', async () => {
  const html = renderToStaticMarkup(await NewPage());
  expect(html).toContain('name="vendorPartyId"');
  expect(html).toContain('name="fromBankAccountId"');
  expect(html).toContain('name="allocation:0:openItemId"');
  expect(html).toContain('name="allocation:0:amount"');
});

it('denies other roles without loading payment data', async () => {
  session.roles = ['accountant'];
  const html = renderToStaticMarkup(await ListPage({ searchParams: Promise.resolve({}) }));
  expect(html).toMatch(/roles/i);
  expect(api.listPaymentRequests).not.toHaveBeenCalled();
});

it('never sends a malformed detail id upstream', async () => {
  await expect(DetailPage({ params: Promise.resolve({ id: '../x' }) })).rejects.toThrow(
    'NOT_FOUND',
  );
  expect(api.getPaymentRequest).not.toHaveBeenCalled();
});
