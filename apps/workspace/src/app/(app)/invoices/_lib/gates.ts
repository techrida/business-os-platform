import { canTransitionInvoice, type InvoiceKind, type InvoiceStatus } from '@bos/contracts';

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
