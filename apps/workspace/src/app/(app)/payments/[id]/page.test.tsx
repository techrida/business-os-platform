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

import PaymentDetailPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getPayment: vi.fn(),
  listPaymentAllocations: vi.fn(),
  getCustomer: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api-receivables', () => ({
  getPayment: mocks.getPayment,
  listPaymentAllocations: mocks.listPaymentAllocations,
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
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't' });
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

  it('falls back to a short id when the customer cannot be read', async () => {
    mocks.getCustomer.mockRejectedValue(new ApiError(403, 'x'));
    expect(await render()).toContain('Customer 33333333');
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
