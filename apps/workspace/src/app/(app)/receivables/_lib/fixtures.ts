// Contract-valid aging and statement data for the tests of the receivables screens. Test-only:
// nothing in the app imports this file. Some fixtures are deliberately inconsistent (a total that
// is not the sum of its buckets) so a test can tell "shows the server's string" from "added it up".
import {
  ArAgingReportSchema,
  CustomerAdvanceSchema,
  InvoiceSettlementSchema,
  type ArAgingReport,
  type CustomerAdvance,
  type InvoiceSettlement,
} from '@bos/contracts';

export const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
export const OTHER_CUSTOMER_ID = '33333333-3333-4333-8333-333333333334';
export const INVOICE_ID = '66666666-6666-4666-8666-666666666666';

const zero = { current: '0.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d91_plus: '0.00' };

/** Buckets that do NOT add up to the stated total, on purpose. */
export function agingRow(over: Record<string, unknown> = {}) {
  return {
    customerId: CUSTOMER_ID,
    customerName: 'Himalayan Traders Pvt. Ltd.',
    currency: 'NPR',
    buckets: { ...zero, current: '100000.00', d1_30: '250000.00', d91_plus: '7.00' },
    totalOpen: '999999.00',
    promiseMissed: false,
    promiseMissedOn: null,
    ...over,
  };
}

export function agingReport(over: Record<string, unknown> = {}): ArAgingReport {
  return ArAgingReportSchema.parse({
    asOf: '2026-11-09',
    rows: [agingRow()],
    totals: [
      {
        currency: 'NPR',
        buckets: { ...zero, current: '123456.00', d1_30: '654321.00', d91_plus: '1.00' },
        totalOpen: '888888.88',
      },
    ],
    ...over,
  });
}

/** `openAmount` is not `total - allocatedAmount`, on purpose. */
export function settlementRow(over: Record<string, unknown> = {}): InvoiceSettlement {
  return InvoiceSettlementSchema.parse({
    invoiceId: INVOICE_ID,
    number: 'INV-2083/84-00007',
    kind: 'tax_invoice',
    issueDate: '2026-10-05',
    customerId: CUSTOMER_ID,
    currency: 'NPR',
    total: '500000.00',
    allocatedAmount: '100000.00',
    openAmount: '123456.78',
    dueDate: '2026-10-20',
    daysOverdue: 20,
    settlement: 'overdue',
    ...over,
  });
}

export function advanceRow(over: Record<string, unknown> = {}): CustomerAdvance {
  return CustomerAdvanceSchema.parse({
    customerId: CUSTOMER_ID,
    currency: 'NPR',
    amount: '250000.00',
    ...over,
  });
}
