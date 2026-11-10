import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import {
  allocationRow,
  CUSTOMER_ID,
  PAYMENT_ID,
  payment,
  PROOF_ID,
  verifiedPayment,
} from '../_lib/fixtures';

import { advance, INVOICE_2_ID, settlement } from './allocate-fixtures';
import PaymentDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getPayment: vi.fn(),
  listPaymentAllocations: vi.fn(),
  getCustomer: vi.fn(),
  getDocument: vi.fn(),
  getCustomerStatement: vi.fn(),
  getCustomerAdvance: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-receivables', () => ({
  getPayment: mocks.getPayment,
  listPaymentAllocations: mocks.listPaymentAllocations,
  getCustomerStatement: mocks.getCustomerStatement,
  getCustomerAdvance: mocks.getCustomerAdvance,
}));
vi.mock('@/components/p2/customers/api', () => ({ getCustomer: mocks.getCustomer }));
vi.mock('@/components/p2/crm/verification-api', () => ({ getDocument: mocks.getDocument }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const VERSION = '88888888-8888-4888-8888-888888888888';

function proofDoc(status: string) {
  return {
    id: PROOF_ID,
    currentVersionId: VERSION,
    versions: [
      {
        id: VERSION,
        documentId: PROOF_ID,
        version: 1,
        filename: 'bank-slip.pdf',
        declaredMime: 'application/pdf',
        detectedMime: 'application/pdf',
        sizeBytes: 2048,
        sha256: null,
        status,
        scanSignature: null,
        scannedAt: null,
        uploadedBy: null,
        createdAt: '2026-11-08T05:45:00.000Z',
      },
    ],
  };
}

async function render(id = PAYMENT_ID): Promise<string> {
  return renderToStaticMarkup(await PaymentDetailPage({ params: Promise.resolve({ id }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: [] });
  mocks.getCustomerStatement.mockResolvedValue([settlement()]);
  mocks.getCustomerAdvance.mockResolvedValue([advance('123456.00')]);
  mocks.getPayment.mockResolvedValue(payment());
  mocks.listPaymentAllocations.mockResolvedValue([]);
  mocks.getCustomer.mockResolvedValue({
    id: CUSTOMER_ID,
    legalName: 'Himalayan Traders Pvt. Ltd.',
  });
  mocks.getDocument.mockResolvedValue(proofDoc('clean'));
});

describe('payment detail', () => {
  it('shows cash, TDS and what the payment settles, as the server sent them', async () => {
    const html = await render();
    expect(html).toContain('NPR 10,00,000.00');
    expect(html).toContain('NPR 15,000.00');
    expect(html).toContain('TDS-1.5');
    expect(html).toContain('NPR 10,15,000.00');
    expect(html).toContain('Himalayan Traders Pvt. Ltd.');
    expect(html).toContain('Awaiting verification');
  });

  it('offers verify and reject while submitted, and not reverse', async () => {
    const html = await render();
    expect(html).toContain('Verify payment');
    expect(html).toContain('>Reject<');
    expect(html).not.toContain('Reverse payment');
  });

  it('offers only reverse once verified, and shows the NPR snapshot and the advance', async () => {
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.listPaymentAllocations.mockResolvedValue([allocationRow()]);
    const html = await render();
    expect(html).toContain('RCPT-2083/84-00001');
    expect(html).toContain('Reverse payment');
    expect(html).not.toContain('Verify payment');
    expect(html).toContain('Value in NPR');
    expect(html).toContain('NPR 2,50,000.00');
    expect(html).toContain('NPR 7,50,000.00');
    expect(html).toContain('Left to allocate');
    expect(html).not.toContain('Customer advance (not yet allocated)');
  });

  it('offers no action on a rejected payment and shows the reason', async () => {
    mocks.getPayment.mockResolvedValue(
      payment({ status: 'rejected', rejectionReason: 'Slip does not match the amount' }),
    );
    const html = await render();
    expect(html).toContain('Slip does not match the amount');
    expect(html).not.toContain('Verify payment');
    expect(html).not.toContain('Reverse payment');
    expect(html).not.toContain('>Reject<');
  });

  it('links a clean proof and shows no link for one that is not clean', async () => {
    const clean = await render();
    expect(clean).toContain(`href="/api/documents/${PROOF_ID}/versions/${VERSION}/download"`);
    expect(clean).toContain('bank-slip.pdf');
    mocks.getDocument.mockResolvedValue(proofDoc('infected'));
    const infected = await render();
    expect(infected).toContain('bank-slip.pdf');
    expect(infected).not.toContain('/download"');
    expect(infected).toContain('Virus found');
  });

  it('says so when a proof cannot be loaded, and still shows the payment', async () => {
    mocks.getDocument.mockRejectedValue(new ApiError(500, 'x'));
    const html = await render();
    expect(html).toContain('could not be loaded');
    expect(html).toContain('NPR 10,00,000.00');
  });

  it('falls back to an unavailable-name label when the customer cannot be read', async () => {
    mocks.getCustomer.mockRejectedValue(new ApiError(403, 'x'));
    expect(await render()).toContain('Customer name unavailable');
  });

  it('says so when the allocations cannot be read, and when there are none', async () => {
    mocks.listPaymentAllocations.mockRejectedValue(new ApiError(500, 'x'));
    expect(await render()).toContain('The allocations could not be loaded');
    mocks.listPaymentAllocations.mockResolvedValue([]);
    expect(await render()).toContain('has not been allocated to any invoice yet');
  });

  it('words 404 and 403 and a failure, and never calls the API for a bad id', async () => {
    mocks.getPayment.mockRejectedValue(new ApiError(404, 'x'));
    expect(await render()).toContain('Payment not found');
    mocks.getPayment.mockRejectedValue(new ApiError(403, 'x'));
    expect(await render()).toContain('Your roles do not include payments');
    mocks.getPayment.mockRejectedValue(new ApiError(500, 'x'));
    const failed = await render();
    expect(failed).toContain('The payment did not load');
    expect(failed).toContain('Reload this payment');
    mocks.getPayment.mockClear();
    expect(await render('not-an-id')).toContain('That is not a payment');
    expect(mocks.getPayment).not.toHaveBeenCalled();
  });
});

const asAccountant = () =>
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
const reversalRow = allocationRow({
  id: '88888888-8888-4888-8888-888888888880',
  amount: '-750000.00',
  reversesAllocationId: '77777777-7777-4777-8777-777777777777',
  reason: 'Wrong invoice',
});

describe('allocate panel on the detail page', () => {
  it('shows on a verified payment for a person with payment.allocate, fed by the open statement', async () => {
    asAccountant();
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    const html = await render();
    expect(html).toContain('Allocate this payment');
    expect(html).toContain('INV-2083/84-00007');
    expect(html).toContain('NPR 1,23,456.00');
    expect(mocks.getCustomerStatement).toHaveBeenCalledWith(
      { accessToken: 't', roles: ['accountant'] },
      CUSTOMER_ID,
      { openOnly: true, currency: 'NPR' },
    );
  });

  it('is hidden without payment.allocate, and the API is not asked for the statement', async () => {
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    for (const roles of [[], ['sales'], ['management']]) {
      mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles });
      const html = await render();
      expect(html).not.toContain('Allocate this payment');
    }
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
    expect(mocks.getCustomerAdvance).not.toHaveBeenCalled();
  });

  it.each([
    ['submitted', payment()],
    ['rejected', payment({ status: 'rejected', rejectionReason: 'Slip unreadable' })],
    ['withdrawn', payment({ status: 'withdrawn' })],
    ['reversed', verifiedPayment({ status: 'reversed' })],
  ] as const)('is hidden while the payment is %s', async (_status, shown) => {
    asAccountant();
    mocks.getPayment.mockResolvedValue(shown);
    expect(await render()).not.toContain('Allocate this payment');
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
  });

  it('says so when the statement fails, and still shows the payment', async () => {
    asAccountant();
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.getCustomerStatement.mockRejectedValue(new ApiError(500, 'x'));
    mocks.getCustomerAdvance.mockRejectedValue(new ApiError(403, 'x'));
    const html = await render();
    expect(html).toContain('The open invoices could not be loaded');
    expect(html).toContain('Could not be loaded');
    expect(html).toContain('RCPT-2083/84-00001');
  });

  it('shows zero advance when the server has no row for this currency', async () => {
    asAccountant();
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.getCustomerAdvance.mockResolvedValue([advance('50.00', 'USD')]);
    const html = await render();
    expect(html).toContain('Customer advance in NPR');
    expect(html).toContain('NPR 0.00');
  });
});

describe('allocations table labels and deallocate', () => {
  const byFilter =
    (full: Promise<unknown>) => (_s: unknown, _c: string, f: { openOnly?: boolean }) =>
      f.openOnly === true ? Promise.resolve([settlement({ invoiceId: INVOICE_2_ID })]) : full;

  it('labels an allocation by invoice number from the full statement, even when it is settled', async () => {
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.listPaymentAllocations.mockResolvedValue([allocationRow()]);
    mocks.getCustomerStatement.mockImplementation(
      byFilter(Promise.resolve([settlement({ number: 'INV-SETTLED-9', openAmount: '0.00' })])),
    );
    asAccountant();
    const html = await render();
    expect(html).toContain('INV-SETTLED-9');
    expect(html).not.toContain('Invoice number unavailable');
    expect(mocks.getCustomerStatement).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID, {
      currency: 'NPR',
    });
    expect(mocks.getCustomerStatement).toHaveBeenCalledWith(expect.anything(), CUSTOMER_ID, {
      openOnly: true,
      currency: 'NPR',
    });
  });

  it('falls back to an unavailable-name label when the statement cannot be read (no ar.read, or a failure)', async () => {
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.listPaymentAllocations.mockResolvedValue([allocationRow()]);
    mocks.getCustomerStatement.mockRejectedValue(new ApiError(403, 'x'));
    expect(await render()).toContain('Invoice number unavailable');
  });

  it('does not ask for a statement just for labels when there are no allocations', async () => {
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.listPaymentAllocations.mockResolvedValue([]);
    await render();
    expect(mocks.getCustomerStatement).not.toHaveBeenCalled();
  });

  it('offers deallocate on live allocations only, not on reversals or already reversed rows', async () => {
    asAccountant();
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    const live = allocationRow({
      id: '77777777-7777-4777-8777-777777777771',
      invoiceId: INVOICE_2_ID,
    });
    mocks.listPaymentAllocations.mockResolvedValue([allocationRow(), reversalRow, live]);
    mocks.getCustomerStatement.mockResolvedValue([
      settlement(),
      settlement({ invoiceId: INVOICE_2_ID, number: 'INV-TWO' }),
    ]);
    const html = await render();
    expect(html.match(/<button[^>]*>Deallocate INV/g)).toHaveLength(1);
    expect(html).toContain('Deallocate INV-TWO');
    expect(html).toContain('Reversed: Wrong invoice');
  });

  it('offers no deallocate without payment.allocate', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['management'] });
    mocks.getPayment.mockResolvedValue(verifiedPayment());
    mocks.listPaymentAllocations.mockResolvedValue([allocationRow()]);
    expect(await render()).not.toContain('Deallocate');
  });
});
