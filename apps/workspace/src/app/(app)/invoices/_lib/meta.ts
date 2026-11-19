// How an invoice kind and status read in the workspace. Pure data and functions with no React import,
// so the list, the detail header and a test can all use them. Serves the NFR "the UI never shows data
// the contract does not promise": a filter is only ever a contract kind, status or settlement, and
// there is deliberately no "paid" among the statuses, because payment state is derived from
// allocations and is not an invoice status. The list page reads its URL with readList.
import {
  INVOICE_KINDS,
  INVOICE_STATUSES,
  type InvoiceKind,
  type InvoiceStatus,
  SETTLEMENT_STATUSES,
  type SettlementStatus,
} from '@bos/contracts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

interface Meta {
  label: string;
  tone: Tone;
}

/** Typed as full records: a kind or status added to the contract is a compile error here until it has words. */
const KINDS: Record<InvoiceKind, Meta> = {
  tax_invoice: { label: 'Tax invoice', tone: 'neutral' },
  proforma: { label: 'Proforma', tone: 'neutral' },
  credit_note: { label: 'Credit note', tone: 'neutral' },
  debit_note: { label: 'Debit note', tone: 'neutral' },
};

const STATUSES: Record<InvoiceStatus, Meta> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Awaiting approval', tone: 'warning' },
  returned: { label: 'Returned', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  issued: { label: 'Issued', tone: 'success' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

export const kindMeta = (kind: InvoiceKind): Meta => KINDS[kind];
export const statusMeta = (status: InvoiceStatus): Meta => STATUSES[status];

/** The filters' options, one per value, in the contract's order. */
export const KIND_FILTER_OPTIONS: readonly { value: InvoiceKind; label: string }[] =
  INVOICE_KINDS.map((value) => ({ value, label: KINDS[value].label }));
export const STATUS_FILTER_OPTIONS: readonly { value: InvoiceStatus; label: string }[] =
  INVOICE_STATUSES.map((value) => ({ value, label: STATUSES[value].label }));

/**
 * Paid and overdue are not invoice statuses: the API derives them from the open item and its allocations
 * and takes them as the separate `settlement` filter, so the status list above never names them.
 */
const SETTLEMENT: Record<SettlementStatus, string> = {
  unpaid: 'Unpaid',
  partly_paid: 'Partly paid',
  paid: 'Paid',
  overdue: 'Overdue',
  credited: 'Credited',
};
export const settlementLabel = (value: string): string =>
  Object.hasOwn(SETTLEMENT, value) ? (SETTLEMENT[value as SettlementStatus] ?? value) : value;
export const SETTLEMENT_FILTER_OPTIONS: readonly { value: SettlementStatus; label: string }[] =
  SETTLEMENT_STATUSES.map((value) => ({ value, label: SETTLEMENT[value] }));

/** Where the approval stands, in one sentence. A proforma has no approval states at all (plan A12). */
export function approvalWords(kind: InvoiceKind, status: InvoiceStatus): string {
  if (kind === 'proforma') return 'No approval needed for a proforma.';
  switch (status) {
    case 'draft':
      return 'Not submitted for approval yet.';
    case 'submitted':
      return 'Awaiting approval.';
    case 'returned':
      return 'Returned for changes.';
    case 'approved':
      return 'Approved. Ready to issue.';
    case 'issued':
      return 'Approved and issued.';
    case 'discarded':
      return 'Discarded.';
  }
}
