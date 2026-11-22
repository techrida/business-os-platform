import { DEFAULT_ROWS, ROWS_OPTIONS } from '@bos/contracts';

/** Same shape the API accepts for `documentType`; the page never sends anything else. */
export const DOCUMENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const INBOX_LIST = {
  multi: { documentType: DOCUMENT_TYPE_PATTERN },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

/** Types that reach an approver today; a type missing here still filters, it just shows its raw key. */
export const DOCUMENT_TYPE_OPTIONS = [
  { value: 'quotation_version', label: 'Quotation' },
  { value: 'tax_invoice', label: 'Tax invoice' },
  { value: 'credit_note', label: 'Credit note' },
  { value: 'debit_note', label: 'Debit note' },
  { value: 'purchase_request', label: 'Purchase request' },
  { value: 'pr_commitment', label: 'PR commitment' },
  { value: 'po_amendment', label: 'PO amendment' },
  { value: 'po_vendor_change', label: 'PO vendor change' },
  { value: 'emergency_review', label: 'Emergency review' },
  { value: 'match_exception', label: 'Match exception' },
  { value: 'vendor_bill', label: 'Vendor bill' },
  { value: 'payment_request', label: 'Payment request' },
  { value: 'test_memo', label: 'Memo' },
] as const;

export function documentTypeLabel(value: string): string {
  return DOCUMENT_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
