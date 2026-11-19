import {
  canTransitionInvoice,
  type InvoiceKind,
  type InvoiceStatus,
  type SettlementStatus,
} from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';

export interface InvoiceGates {
  /** Send for approval (also resubmits a returned invoice). Never for a proforma. */
  submit: boolean;
  /** Issue: an approved invoice, or a proforma draft (which has no approval step). */
  issue: boolean;
  discard: boolean;
  /** Where the "Credit note" and "Debit note" buttons mount: an issued tax invoice, for Finance. */
  notes: boolean;
}

/**
 * Which actions one invoice offers to one person: the contract's transition table decides whether the
 * move exists, the person's role decides whether they may make it. Both must say yes. This only
 * decides what to show; the API enforces the same rules again on every call.
 *
 * Permissions (the brief names the first, second and fourth; discard and proforma issue are choices):
 *  - submit  `invoice.submit` (Accountant or Finance)
 *  - issue   `invoice.issue` (Finance), a proforma too
 *  - discard `invoice.draft` (Accountant or Finance)
 *  - notes   `invoice.credit_note` (Finance), for credit and debit notes alike (there is no
 *    separate debit permission). A proforma is not corrected by a note: it opens no open item.
 */
export function invoiceGates(
  invoice: { kind: InvoiceKind; status: InvoiceStatus },
  roles: readonly string[],
): InvoiceGates {
  const { kind, status } = invoice;
  return {
    submit:
      canTransitionInvoice(kind, status, 'submitted') && hasPermission(roles, 'invoice.submit'),
    issue: canTransitionInvoice(kind, status, 'issued') && hasPermission(roles, 'invoice.issue'),
    discard:
      canTransitionInvoice(kind, status, 'discarded') && hasPermission(roles, 'invoice.draft'),
    notes:
      kind === 'tax_invoice' && status === 'issued' && hasPermission(roles, 'invoice.credit_note'),
  };
}

/** The settlements that still leave something to pay. */
const PAYABLE: ReadonlySet<SettlementStatus> = new Set(['unpaid', 'partly_paid', 'overdue']);

/**
 * True only when the Payment filter selects owing states alone (unpaid, partly paid, overdue). The list rows carry no
 * paid state, so without that filter a row could be settled and the list offers no Record payment button.
 */
export function settlementMayOwe(selected: readonly string[]): boolean {
  return selected.length > 0 && selected.every((s) => PAYABLE.has(s as SettlementStatus));
}

/**
 * Where "Record payment" leads for one invoice, or null when it is not offered. Only an issued tax invoice or debit
 * note opens an item a customer pays, and only `payment.record` (the permission the payment form checks) sees the
 * button. A payment is recorded against the customer and allocated to invoices afterwards, so the link preselects the
 * customer on the payment form.
 *
 * `settlement` is the server's derived state when the caller has read it (the detail page): a settled invoice, or one
 * whose state did not load (null), offers nothing. Left out (the list, whose rows carry no paid state), the button is
 * offered on every issued tax invoice and debit note.
 */
export function recordPaymentHref(
  invoice: { kind: InvoiceKind; status: InvoiceStatus; customerId: string },
  roles: readonly string[],
  settlement?: SettlementStatus | null,
): string | null {
  const { kind, status, customerId } = invoice;
  if (status !== 'issued' || (kind !== 'tax_invoice' && kind !== 'debit_note')) return null;
  if (!hasPermission(roles, 'payment.record')) return null;
  if (settlement !== undefined && (settlement === null || !PAYABLE.has(settlement))) return null;
  return `/payments/new?customerId=${encodeURIComponent(customerId)}`;
}
