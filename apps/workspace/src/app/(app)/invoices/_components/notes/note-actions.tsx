import { randomUUID } from 'node:crypto';

import type { Currency, InvoiceDto, InvoiceLineDto, TaxCode } from '@bos/contracts';

import type { InvoiceGates } from '../../_lib/gates';

import { CreditNoteDialog, DebitNoteDialog } from './note-dialogs';

/**
 * The "Credit note" and "Debit note" buttons for the detail page's note slot, only where
 * `invoiceGates.notes` allows it (an issued tax invoice, for a person with `invoice.credit_note`).
 * Server Component: it generates one Idempotency-Key per note for this render (the forms send it, and
 * keep it after an unknown outcome so a landed call cannot apply twice) and hands the dialogs plain
 * data. Returns nothing when the gate is closed, so the slot stays empty.
 */
export function InvoiceNoteActions({
  invoice,
  lines,
  taxCodes,
  gates,
}: {
  invoice: Pick<InvoiceDto, 'id' | 'number'> & { currency: Currency };
  /** The original invoice's lines: a credit note names them and a quantity each. */
  lines: readonly InvoiceLineDto[];
  /** null when the list failed to load: the debit note then says so and cannot be created. */
  taxCodes: readonly TaxCode[] | null;
  gates: InvoiceGates;
}) {
  if (!gates.notes) return null;
  // Project data on the server; functions from a client module cannot be called here.
  const creditLines = lines.map(({ lineNo, description, uom, quantity }) => ({
    lineNo,
    description,
    uom,
    quantity,
  }));
  const ids = {
    originalInvoiceId: invoice.id,
    name: invoice.number ?? 'this invoice',
    reloadHref: `/invoices/${encodeURIComponent(invoice.id)}`,
  };
  return (
    <>
      <CreditNoteDialog {...ids} lines={creditLines} idempotencyKey={randomUUID()} />
      <DebitNoteDialog
        {...ids}
        currency={invoice.currency}
        taxCodes={taxCodes}
        idempotencyKey={randomUUID()}
      />
    </>
  );
}
