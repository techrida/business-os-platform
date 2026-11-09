// Contract-valid statement and advance rows for the allocate tests. Test-only: nothing in the app
// imports this file.
import { CustomerAdvanceSchema, InvoiceSettlementSchema } from '@bos/contracts';

import { CUSTOMER_ID, INVOICE_ID } from '../_lib/fixtures';

export const INVOICE_2_ID = '99999999-9999-4999-8999-999999999999';

export function settlement(over: Record<string, unknown> = {}) {
  return InvoiceSettlementSchema.parse({
    invoiceId: INVOICE_ID,
    number: 'INV-2083/84-00007',
    customerId: CUSTOMER_ID,
    currency: 'NPR',
    total: '500000.00',
    allocatedAmount: '250000.00',
    openAmount: '250000.00',
    dueDate: '2026-11-20',
    daysOverdue: 0,
    settlement: 'partly_paid',
    ...over,
  });
}

export function advance(amount: string, currency = 'NPR') {
  return CustomerAdvanceSchema.parse({ customerId: CUSTOMER_ID, currency, amount });
}
