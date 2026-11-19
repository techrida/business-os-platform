import {
  canTransitionInvoice,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  type InvoiceKind,
  type InvoiceStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { invoiceGates, recordPaymentHref, settlementMayOwe } from './gates';

const ACCOUNTANT = ['accountant'];
const FINANCE = ['finance'];
const NOBODY = ['sales'];
const NONE = { submit: false, issue: false, discard: false, notes: false };

const gates = (kind: InvoiceKind, status: InvoiceStatus, roles: string[]) =>
  invoiceGates({ kind, status }, roles);

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
      notes: false,
    });
  });

  it.each(['draft', 'returned'] as const)(
    'lets Finance submit and discard a %s tax invoice with its own grants',
    (status) => {
      expect(gates('tax_invoice', status, FINANCE)).toEqual({
        submit: true,
        issue: false,
        discard: true,
        notes: false,
      });
    },
  );

  it('offers Issue only to Finance, and only once approved', () => {
    expect(gates('tax_invoice', 'approved', FINANCE).issue).toBe(true);
    expect(gates('tax_invoice', 'approved', ACCOUNTANT).issue).toBe(false);
    expect(gates('tax_invoice', 'submitted', FINANCE).issue).toBe(false);
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

  it('offers nothing to a role with no invoice grants, or to nobody', () => {
    for (const status of INVOICE_STATUSES) {
      expect(gates('tax_invoice', status, NOBODY)).toEqual(NONE);
      expect(gates('tax_invoice', status, [])).toEqual(NONE);
    }
  });
});

describe('recordPaymentHref', () => {
  const CUSTOMER = '33333333-3333-4333-8333-333333333333';
  const HREF = `/payments/new?customerId=${CUSTOMER}`;
  const href = (
    kind: InvoiceKind,
    status: InvoiceStatus,
    roles: string[],
    settlement?: Parameters<typeof recordPaymentHref>[2],
  ) => recordPaymentHref({ kind, status, customerId: CUSTOMER }, roles, settlement);

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

  it('follows a settlement the caller read: open ones yes, settled or unknown no', () => {
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'unpaid')).toBe(HREF);
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'partly_paid')).toBe(HREF);
    expect(href('debit_note', 'issued', ACCOUNTANT, 'overdue')).toBe(HREF);
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'paid')).toBeNull();
    expect(href('tax_invoice', 'issued', ACCOUNTANT, 'credited')).toBeNull();
    expect(href('tax_invoice', 'issued', ACCOUNTANT, null)).toBeNull();
  });
});

describe('settlementMayOwe', () => {
  it('offers Record payment on the list only when the filter selects owing states alone', () => {
    expect(settlementMayOwe([])).toBe(false);
    expect(settlementMayOwe(['unpaid', 'overdue'])).toBe(true);
    expect(settlementMayOwe(['paid', 'overdue'])).toBe(false);
    expect(settlementMayOwe(['paid'])).toBe(false);
    expect(settlementMayOwe(['credited'])).toBe(false);
  });
});
