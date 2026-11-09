// Contract-valid payment and allocation rows for the tests of the payments screens and their API
// layer. Test-only: nothing in the app imports this file.
import { PaymentDtoSchema, type PaymentDto } from '@bos/contracts';

export const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
export const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
export const SUBMITTER_ID = '44444444-4444-4444-8444-444444444441';
export const VERIFIER_ID = '44444444-4444-4444-8444-444444444442';
export const PROOF_ID = '55555555-5555-4555-8555-555555555555';
export const INVOICE_ID = '66666666-6666-4666-8666-666666666666';
const WHEN = '2026-11-08T05:45:00.000Z';

export function payment(over: Record<string, unknown> = {}): PaymentDto {
  return PaymentDtoSchema.parse({
    id: PAYMENT_ID,
    customerId: CUSTOMER_ID,
    status: 'submitted',
    method: 'bank_transfer',
    currency: 'NPR',
    amount: '1000000.00',
    tdsWithheld: '15000.00',
    withholdingCode: 'TDS-1.5',
    settles: '1015000.00',
    receivedOn: '2026-11-05',
    bankReference: 'NIC-77812',
    npr: null,
    submittedBy: SUBMITTER_ID,
    submittedVia: 'staff',
    verifiedBy: null,
    verifiedAt: null,
    rejectionReason: null,
    number: null,
    fiscalYear: null,
    proofDocumentIds: [PROOF_ID],
    unallocatedAmount: '0.00',
    version: 3,
    createdAt: WHEN,
    updatedAt: WHEN,
    ...over,
  });
}

export function verifiedPayment(over: Record<string, unknown> = {}): PaymentDto {
  return payment({
    status: 'verified',
    verifiedBy: VERIFIER_ID,
    verifiedAt: WHEN,
    number: 'RCPT-2083/84-00001',
    fiscalYear: '2083/84',
    npr: {
      amountNpr: '1000000.00',
      rate: '1.000000',
      rateSource: 'identity',
      rateDate: '2026-11-05',
    },
    unallocatedAmount: '250000.00',
    ...over,
  });
}

export function listItem(over: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    customerId: CUSTOMER_ID,
    customerName: 'Himalayan Traders Pvt. Ltd.',
    status: 'submitted',
    number: null,
    method: 'bank_transfer',
    currency: 'NPR',
    amount: '1000000.00',
    receivedOn: '2026-11-05',
    unallocatedAmount: '0.00',
    ...over,
  };
}

export function allocationRow(over: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    invoiceId: INVOICE_ID,
    paymentId: PAYMENT_ID,
    creditNoteId: null,
    amount: '750000.00',
    reversesAllocationId: null,
    reason: null,
    createdBy: VERIFIER_ID,
    createdAt: WHEN,
    ...over,
  };
}
