import {
  canTransitionInvoice,
  isInvoiceEditable,
  type InvoiceCan,
  type InvoiceKind,
  type InvoiceStatus,
  type Permission,
  type SettlementStatus,
} from '@bos/contracts';

/** Whether the person holds a permission: their live grants on the pages, a plain predicate in tests. */
export type Can = (permission: Permission) => boolean;

/**
 * The API's per-invoice answer (list rows and detail): whether the person's grant scope reaches this invoice for
 * each action (an `own` grant does not reach another person's draft). A false flag hides the action; no `can` at
 * all (an older API, a command response) leaves the decision to the grants alone.
 */
type Reach = { can?: InvoiceCan | undefined };

function reaches(invoice: Reach, action: Exclude<keyof InvoiceCan, 'editDueDate'>): boolean {
  return invoice.can?.[action] !== false;
}

export interface InvoiceGates {
  /** Send for approval (also resubmits a returned invoice). Never for a proforma. */
  submit: boolean;
  /** Issue: an approved invoice, or a proforma draft (which has no approval step). */
  issue: boolean;
  discard: boolean;
  /**
   * Back to draft: an approved invoice that can no longer be issued as approved (its due date passed). Whoever may
   * issue it may take it back; it then needs a new approval.
   */
  reopen: boolean;
  /**
   * "Edit due date" on a draft or returned invoice, or null when it is not offered. Shown to whoever may draft this
   * invoice (the same reach as Discard, so the action slot is already mounted); `reason` is the API's words for why it
   * is off (an order's invoice or a note takes its due date at issue), null when it works.
   */
  editDueDate: { reason: string | null } | null;
  /** Where the "Credit note" and "Debit note" buttons mount: an issued tax invoice, for Finance. */
  notes: boolean;
  /**
   * Why Issue is shown but off, or null when it works. Only a credit or debit note its viewer created (TR-Q12f): its
   * issuer must be someone else, and the API refuses the creator too.
   */
  issueBlocker: string | null;
}

/** The reason on a note's Issue button when its viewer created it. */
export const NOTE_CREATOR_CANNOT_ISSUE =
  'You created this note, so someone else with issue access must issue it.';

/** The reason on "Edit due date" when the API refused without one. */
export const DUE_DATE_NOT_EDITABLE = "This invoice's due date cannot be changed.";

/**
 * Which actions one invoice offers to one person: the contract's transition table decides whether the
 * move exists, the person's grants decide whether they may make it. Both must say yes. This only
 * decides what to show; the API enforces the same rules again on every call.
 *
 * Permissions (the brief names the first, second and fourth; discard and proforma issue are choices):
 *  - submit  `invoice.submit` (Accountant or Finance)
 *  - issue   `invoice.issue` (Finance), a proforma too
 *  - discard `invoice.draft` (Accountant or Finance)
 *  - notes   `invoice.credit_note` (Finance), for credit and debit notes alike (there is no
 *    separate debit permission). A proforma is not corrected by a note: it opens no open item.
 *  - editDueDate `invoice.draft` on a draft or returned invoice, only when the detail sent `can.editDueDate`
 *    (the list rows do not), which also decides whether it is on and why not.
 * * Each also needs `invoice.can` to allow it when the API sent one. A note's creator sees Issue off, with
 * `issueBlocker` saying why (TR-Q12f).
 */
export function invoiceGates(
  invoice: { kind: InvoiceKind; status: InvoiceStatus } & Reach,
  can: Can,
  /** The detail's `issueBlockedBySod`: the server says the viewer created this note. */
  createdByViewer = false,
): InvoiceGates {
  const { kind, status } = invoice;
  const issue =
    canTransitionInvoice(kind, status, 'issued') &&
    can('invoice.issue') &&
    reaches(invoice, 'issue');
  const isNote = kind === 'credit_note' || kind === 'debit_note';
  const discard =
    canTransitionInvoice(kind, status, 'discarded') &&
    can('invoice.draft') &&
    reaches(invoice, 'discard');
  return {
    submit:
      canTransitionInvoice(kind, status, 'submitted') &&
      can('invoice.submit') &&
      reaches(invoice, 'submit'),
    issue,
    discard,
    reopen:
      status === 'approved' &&
      canTransitionInvoice(kind, status, 'draft') &&
      can('invoice.issue') &&
      reaches(invoice, 'issue'),
    editDueDate: editDueDateGate(invoice, discard),
    notes:
      kind === 'tax_invoice' &&
      status === 'issued' &&
      can('invoice.credit_note') &&
      reaches(invoice, 'notes'),
    issueBlocker: issue && isNote && createdByViewer ? NOTE_CREATOR_CANNOT_ISSUE : null,
  };
}

/**
 * Offered only beside Discard (the same `invoice.draft` grant and reach, on a document still being drafted): someone
 * whose draft grant does not reach this invoice is offered nothing, and the page's action slot, which mounts for
 * Discard, is always there for it.
 */
function editDueDateGate(
  invoice: { status: InvoiceStatus } & Reach,
  discard: boolean,
): InvoiceGates['editDueDate'] {
  const answer = invoice.can?.editDueDate;
  if (answer === undefined || !discard || !isInvoiceEditable(invoice.status)) return null;
  return { reason: answer.allowed ? null : (answer.reason ?? DUE_DATE_NOT_EDITABLE) };
}

/** The settlements that still leave something to pay. */
const PAYABLE: ReadonlySet<SettlementStatus> = new Set(['unpaid', 'partly_paid', 'overdue']);

/** True when the server's derived settlement still leaves something to pay; null (not loaded) is not. */
export function isPayableSettlement(settlement: SettlementStatus | null | undefined): boolean {
  return settlement != null && PAYABLE.has(settlement);
}

/**
 * Where "Record payment" leads for one invoice, or null when it is not offered. Only an issued tax invoice or debit
 * note opens an item a customer pays, and only `payment.record` (the permission the payment form checks) sees the
 * button. A payment is recorded against the customer and allocated to invoices afterwards, so the link preselects the
 * customer on the payment form and names the invoice: the form reads that invoice itself and starts on its currency
 * and the open amount the server reports (U16-Q8 a). The link carries no amount.
 *
 * `settlement` is the server's derived state (the detail page and each list row carry it, U15b-Q2): a settled invoice,
 * or one whose state did not load (null), offers nothing. Left out, the button is offered on every issued tax invoice
 * and debit note. A `can.recordPayment` of false (the grant does not reach this customer) offers nothing.
 */
export function recordPaymentHref(
  invoice: { id: string; kind: InvoiceKind; status: InvoiceStatus; customerId: string } & Reach,
  can: Can,
  settlement?: SettlementStatus | null,
): string | null {
  const { id, kind, status, customerId } = invoice;
  if (status !== 'issued' || (kind !== 'tax_invoice' && kind !== 'debit_note')) return null;
  if (!can('payment.record') || !reaches(invoice, 'recordPayment')) return null;
  if (settlement !== undefined && !isPayableSettlement(settlement)) return null;
  return `/payments/new?customerId=${encodeURIComponent(customerId)}&invoiceId=${encodeURIComponent(id)}`;
}
