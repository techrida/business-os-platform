import {
  canTransitionInvoice,
  INVOICE_KINDS,
  InvoiceCanSchema,
  isInvoiceEditable,
  INVOICE_STATUSES,
  type InvoiceKind,
  type InvoiceStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { permissionChecker } from '@/components/p2/customers/permissions';

import {
  type Can,
  DUE_DATE_NOT_EDITABLE,
  invoiceGates,
  NOTE_CREATOR_CANNOT_ISSUE,
  recordPaymentHref,
} from './gates';

const ACCOUNTANT = ['accountant'];
const FINANCE = ['finance'];
const NOBODY = ['sales'];
const NONE = {
  submit: false,
  issue: false,
  discard: false,
  reopen: false,
  notes: false,
  editDueDate: null,
  issueBlocker: null,
};

const gates = (kind: InvoiceKind, status: InvoiceStatus, roles: string[]) =>
  invoiceGates({ kind, status }, permissionChecker(roles));

/** A person's live grants as Settings > Access left them, whatever their roles' defaults say. */
const granted =
  (...permissions: string[]): Can =>
  (p) =>
    permissions.includes(p);

describe('invoiceGates follow canTransitionInvoice and the role', () => {
  it.each(INVOICE_KINDS.flatMap((k) => INVOICE_STATUSES.map((s) => [k, s] as const)))(
    '%s %s',
    (kind, status) => {
      // Both roles together: the only thing left deciding is the transition table.
      const g = gates(kind, status, ['accountant', 'finance']);
      expect(g.submit).toBe(canTransitionInvoice(kind, status, 'submitted'));
      expect(g.issue).toBe(canTransitionInvoice(kind, status, 'issued'));
      expect(g.discard).toBe(canTransitionInvoice(kind, status, 'discarded'));
      // The slot for the note buttons exists only on an issued tax invoice.
      expect(g.notes).toBe(kind === 'tax_invoice' && status === 'issued');
    },
  );

  it('offers Submit and Discard, not Issue, on a draft tax invoice', () => {
    expect(gates('tax_invoice', 'draft', ACCOUNTANT)).toEqual({
      submit: true,
      issue: false,
      discard: true,
      reopen: false,
      notes: false,
      editDueDate: null,
      issueBlocker: null,
    });
  });

  it.each(['draft', 'returned'] as const)(
    'lets Finance submit and discard a %s tax invoice with its own grants',
    (status) => {
      expect(gates('tax_invoice', status, FINANCE)).toEqual({
        submit: true,
        issue: false,
        discard: true,
        reopen: false,
        notes: false,
        editDueDate: null,
        issueBlocker: null,
      });
    },
  );

  it('offers Issue only to Finance, and only once approved', () => {
    expect(gates('tax_invoice', 'approved', FINANCE).issue).toBe(true);
    expect(gates('tax_invoice', 'approved', ACCOUNTANT).issue).toBe(false);
    expect(gates('tax_invoice', 'submitted', FINANCE).issue).toBe(false);
  });

  it('offers Back to draft on an approved invoice only, to whoever may issue it', () => {
    expect(gates('tax_invoice', 'approved', FINANCE).reopen).toBe(true);
    expect(gates('debit_note', 'approved', FINANCE).reopen).toBe(true);
    expect(gates('tax_invoice', 'approved', ACCOUNTANT).reopen).toBe(false);
    for (const status of INVOICE_STATUSES.filter((s) => s !== 'approved')) {
      expect(gates('tax_invoice', status, ['accountant', 'finance']).reopen).toBe(false);
    }
    expect(gates('proforma', 'approved', FINANCE).reopen).toBe(false);
    // The per-invoice issue flag decides it too: an own-scoped grant on another person's invoice.
    expect(
      invoiceGates(
        {
          kind: 'tax_invoice',
          status: 'approved',
          can: { submit: true, issue: false, discard: true, notes: true, recordPayment: true },
        },
        permissionChecker(FINANCE),
      ).reopen,
    ).toBe(false);
  });

  it('goes straight from a draft proforma to Issue, with no Submit', () => {
    const g = gates('proforma', 'draft', ['accountant', 'finance']);
    expect(g.submit).toBe(false);
    expect(g.issue).toBe(true);
    expect(g.discard).toBe(true);
  });

  it('lets an Accountant resubmit and discard a returned note', () => {
    const g = gates('credit_note', 'returned', ACCOUNTANT);
    expect(g.submit).toBe(true);
    expect(g.discard).toBe(true);
  });

  it('shows the note slot to Finance only', () => {
    expect(gates('tax_invoice', 'issued', FINANCE).notes).toBe(true);
    expect(gates('tax_invoice', 'issued', ACCOUNTANT).notes).toBe(false);
    expect(gates('proforma', 'issued', FINANCE).notes).toBe(false);
  });

  it('follows the live grants, not the role defaults', () => {
    // A Sales user granted invoice.draft and invoice.submit in Settings > Access.
    expect(
      invoiceGates(
        { kind: 'tax_invoice', status: 'draft' },
        granted('invoice.draft', 'invoice.submit'),
      ),
    ).toEqual({
      submit: true,
      issue: false,
      discard: true,
      reopen: false,
      notes: false,
      editDueDate: null,
      issueBlocker: null,
    });
    // A Finance user whose invoice.issue and invoice.credit_note were revoked.
    expect(
      invoiceGates({ kind: 'tax_invoice', status: 'approved' }, granted('invoice.draft')).issue,
    ).toBe(false);
    expect(invoiceGates({ kind: 'tax_invoice', status: 'issued' }, granted()).notes).toBe(false);
  });

  it('offers nothing to a role with no invoice grants, or to nobody', () => {
    for (const status of INVOICE_STATUSES) {
      expect(gates('tax_invoice', status, NOBODY)).toEqual(NONE);
      expect(gates('tax_invoice', status, [])).toEqual(NONE);
    }
  });
});

describe('recordPaymentHref', () => {
  const CUSTOMER = '33333333-3333-4333-8333-333333333333';
  const INVOICE = '11111111-1111-4111-8111-111111111111';
  const HREF = `/payments/new?customerId=${CUSTOMER}&invoiceId=${INVOICE}`;
  const href = (
    kind: InvoiceKind,
    status: InvoiceStatus,
    roles: string[],
    settlement?: Parameters<typeof recordPaymentHref>[2],
  ) =>
    recordPaymentHref(
      { id: INVOICE, kind, status, customerId: CUSTOMER },
      permissionChecker(roles),
      settlement,
    );

  it.each(INVOICE_KINDS.flatMap((k) => INVOICE_STATUSES.map((s) => [k, s] as const)))(
    'offers it on %s %s only when it opens a receivable',
    (kind, status) => {
      const open = status === 'issued' && (kind === 'tax_invoice' || kind === 'debit_note');
      expect(href(kind, status, ACCOUNTANT)).toBe(open ? HREF : null);
    },
  );

  it('needs payment.record, the permission the payment form checks', () => {
    expect(href('tax_invoice', 'issued', FINANCE)).toBe(HREF);
    expect(href('tax_invoice', 'issued', ['founder'])).toBe(HREF);
    expect(href('tax_invoice', 'issued', ['management'])).toBeNull();
    expect(href('tax_invoice', 'issued', NOBODY)).toBeNull();
  });

  it('follows a live payment.record grant, not the role defaults', () => {
    const invoice = {
      id: INVOICE,
      kind: 'tax_invoice',
      status: 'issued',
      customerId: CUSTOMER,
    } as const;
    expect(recordPaymentHref(invoice, granted('payment.record'))).toBe(HREF);
    expect(recordPaymentHref(invoice, granted('invoice.draft'))).toBeNull();
  });

  it('follows a settlement the caller read: open ones yes, settled or unknown no', () => {
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'unpaid')).toBe(HREF);
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'partly_paid')).toBe(HREF);
    expect(href('debit_note', 'issued', ACCOUNTANT, 'overdue')).toBe(HREF);
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'paid')).toBeNull();
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'credited')).toBeNull();
    expect(href('tax_invoice', 'issued', ACCOUNTANT, null)).toBeNull();
  });

  it('names the invoice in the link, so the payment form can start on its open amount (U16-Q8 a)', () => {
    const url = new URL(href('debit_note', 'issued', ACCOUNTANT, 'unpaid')!, 'https://app.test');
    expect(url.pathname).toBe('/payments/new');
    expect(url.searchParams.get('customerId')).toBe(CUSTOMER);
    // Old code sent the customer only.
    expect(url.searchParams.get('invoiceId')).toBe(INVOICE);
    // The amount is never carried in the link: the form reads it from the API.
    expect([...url.searchParams.keys()].sort()).toEqual(['customerId', 'invoiceId']);
  });
});

describe('a note its viewer created (TR-Q12f)', () => {
  it.each(['credit_note', 'debit_note'] as const)(
    'keeps Issue on an approved %s but says why it is off',
    (kind) => {
      const g = invoiceGates({ kind, status: 'approved' }, permissionChecker(FINANCE), true);
      expect(g.issue).toBe(true);
      expect(g.issueBlocker).toBe(NOTE_CREATOR_CANNOT_ISSUE);
    },
  );

  it('blocks nothing for another viewer, a tax invoice, or a note not yet approved', () => {
    expect(
      invoiceGates({ kind: 'debit_note', status: 'approved' }, permissionChecker(FINANCE), false)
        .issueBlocker,
    ).toBeNull();
    expect(
      invoiceGates({ kind: 'tax_invoice', status: 'approved' }, permissionChecker(FINANCE), true)
        .issueBlocker,
    ).toBeNull();
    expect(
      invoiceGates({ kind: 'credit_note', status: 'draft' }, permissionChecker(FINANCE), true)
        .issueBlocker,
    ).toBeNull();
  });
});

describe('the per-invoice can flags', () => {
  const CUSTOMER = '33333333-3333-4333-8333-333333333333';
  const INVOICE = '11111111-1111-4111-8111-111111111111';
  const HREF = `/payments/new?customerId=${CUSTOMER}&invoiceId=${INVOICE}`;
  // Finance holds every invoice permission at some scope; only the API's per-invoice answer tells another
  // person's invoice from their own under an `own` grant.
  const finance = permissionChecker(FINANCE);
  const OTHERS = {
    submit: false,
    issue: false,
    discard: false,
    notes: false,
    recordPayment: false,
  };
  const OWN = { submit: true, issue: true, discard: true, notes: true, recordPayment: true };
  const draft = { kind: 'tax_invoice', status: 'draft' } as const;
  const approved = { kind: 'tax_invoice', status: 'approved' } as const;
  const issued = {
    id: INVOICE,
    kind: 'tax_invoice',
    status: 'issued',
    customerId: CUSTOMER,
  } as const;

  it("hides Submit, Issue, Discard, the notes and Record payment on another person's invoice", () => {
    expect(invoiceGates({ ...draft, can: OTHERS }, finance)).toEqual(NONE);
    expect(invoiceGates({ ...approved, can: OTHERS }, finance)).toEqual(NONE);
    expect(invoiceGates({ ...issued, can: OTHERS }, finance)).toEqual(NONE);
    expect(recordPaymentHref({ ...issued, can: OTHERS }, finance)).toBeNull();
    expect(recordPaymentHref({ ...issued, can: OTHERS }, finance, 'unpaid')).toBeNull();
  });

  it("offers them on the person's own invoice as the status allows", () => {
    expect(invoiceGates({ ...draft, can: OWN }, finance)).toEqual({
      ...NONE,
      submit: true,
      discard: true,
    });
    expect(invoiceGates({ ...approved, can: OWN }, finance).issue).toBe(true);
    expect(invoiceGates({ ...issued, can: OWN }, finance).notes).toBe(true);
    expect(recordPaymentHref({ ...issued, can: OWN }, finance)).toBe(HREF);
  });

  it('decides each action by its own flag', () => {
    expect(invoiceGates({ ...draft, can: { ...OWN, submit: false } }, finance)).toEqual({
      ...NONE,
      discard: true,
    });
    expect(invoiceGates({ ...issued, can: { ...OWN, notes: false } }, finance).notes).toBe(false);
    expect(recordPaymentHref({ ...issued, can: { ...OWN, recordPayment: false } }, finance)).toBe(
      null,
    );
    expect(recordPaymentHref({ ...issued, can: { ...OTHERS, recordPayment: true } }, finance)).toBe(
      HREF,
    );
  });

  it('keeps the grant-only behaviour when the response has no can', () => {
    expect(invoiceGates(draft, finance)).toEqual({ ...NONE, submit: true, discard: true });
    expect(invoiceGates({ ...approved, can: undefined }, finance).issue).toBe(true);
    expect(recordPaymentHref(issued, finance)).toBe(HREF);
  });

  it('never lets a true flag stand in for a missing grant or a move the status refuses', () => {
    expect(invoiceGates({ ...draft, can: OWN }, granted())).toEqual(NONE);
    expect(invoiceGates({ kind: 'tax_invoice', status: 'discarded', can: OWN }, finance)).toEqual(
      NONE,
    );
    expect(recordPaymentHref({ ...issued, can: OWN }, granted())).toBeNull();
  });
});

describe("Edit due date (the detail's can.editDueDate)", () => {
  // The API's words, as `dueDateEditRefusal` in invoice-mapping.ts sends them.
  const ORDER =
    "This invoice's due date is set when it is issued, from the sales order's credit days";
  const DEBIT = "A debit note's due date is set when it is issued";
  const CREDIT = 'A credit note has no due date of its own';
  const finance = permissionChecker(FINANCE);
  const detail = (editDueDate: unknown, discard = true) =>
    InvoiceCanSchema.parse({
      submit: true,
      issue: true,
      discard,
      notes: true,
      recordPayment: false,
      editDueDate,
    });

  it('offers it on a draft or returned invoice the API allows', () => {
    for (const status of ['draft', 'returned'] as const) {
      const g = invoiceGates(
        { kind: 'tax_invoice', status, can: detail({ allowed: true }) },
        permissionChecker(ACCOUNTANT),
      );
      expect(g.editDueDate).toEqual({ reason: null });
    }
  });

  it.each([
    ['tax_invoice', ORDER],
    ['debit_note', DEBIT],
    ['credit_note', CREDIT],
  ] as const)('shows a %s off with the API reason, never hidden', (kind, reason) => {
    const g = invoiceGates(
      { kind, status: 'draft', can: detail({ allowed: false, reason }) },
      finance,
    );
    expect(g.editDueDate).toEqual({ reason });
  });

  it('falls back to plain words when the API refuses without a reason', () => {
    const g = invoiceGates(
      { kind: 'proforma', status: 'draft', can: detail({ allowed: false }) },
      finance,
    );
    expect(g.editDueDate).toEqual({ reason: DUE_DATE_NOT_EDITABLE });
  });

  it('is not offered outside draft and returned, without invoice.draft, out of reach, or with no answer', () => {
    for (const status of ['submitted', 'approved', 'issued', 'discarded'] as const) {
      expect(
        invoiceGates({ kind: 'tax_invoice', status, can: detail({ allowed: true }) }, finance)
          .editDueDate,
      ).toBeNull();
    }
    const draft = { kind: 'tax_invoice', status: 'draft' } as const;
    expect(
      invoiceGates({ ...draft, can: detail({ allowed: true }) }, granted('invoice.submit'))
        .editDueDate,
    ).toBeNull();
    // Another person's draft under an `own` grant: the API refuses (403) and Discard is hidden too.
    expect(
      invoiceGates({ ...draft, can: detail({ allowed: false, reason: 'x' }, false) }, finance)
        .editDueDate,
    ).toBeNull();
    // A list row, or an older API: no answer, no button.
    expect(invoiceGates({ ...draft, can: detail(undefined) }, finance).editDueDate).toBeNull();
    expect(invoiceGates(draft, finance).editDueDate).toBeNull();
  });

  // The detail page mounts the action slot only for Submit, Issue, Back to draft, Discard or a payment; an offered
  // Edit due date must never be the only action, or it would not show.
  it.each(
    INVOICE_KINDS.flatMap((k) =>
      INVOICE_STATUSES.filter(isInvoiceEditable).map((s) => [k, s] as const),
    ),
  )('an offered Edit due date on a %s %s always comes with Discard', (kind, status) => {
    for (const editDueDate of [{ allowed: true }, { allowed: false, reason: ORDER }]) {
      const g = invoiceGates({ kind, status, can: detail(editDueDate) }, finance);
      if (g.editDueDate !== null) expect(g.discard).toBe(true);
    }
  });
});
