import {
  canTransitionInvoice,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  type InvoiceKind,
  type InvoiceStatus,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { invoiceGates } from './gates';

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
