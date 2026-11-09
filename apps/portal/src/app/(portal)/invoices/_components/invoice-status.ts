import type { CustomerInvoiceView, SettlementStatus } from '@bos/contracts';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** How a derived settlement status reads to the customer. The server decides the status; this only names it. */
export const SETTLEMENT_LOOK: Record<SettlementStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'info' },
  partly_paid: { label: 'Partly paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'error' },
  credited: { label: 'Credited', tone: 'neutral' },
};

export const KIND_LABEL: Record<CustomerInvoiceView['kind'], string> = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
};

/** A payment can be sent for an invoice or debit note that is still owed. The API decides in the end. */
export function canPay(kind: CustomerInvoiceView['kind'], settlement: SettlementStatus): boolean {
  return (
    kind !== 'credit_note' &&
    (settlement === 'unpaid' || settlement === 'partly_paid' || settlement === 'overdue')
  );
}
