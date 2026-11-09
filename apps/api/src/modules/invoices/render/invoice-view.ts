// The whitelist an invoice PDF is drawn from (P3 unit U11). The template is given this view and nothing else, so it
// cannot print an NPR value, an FX rate, a content hash, an approval, an editor or a manual reason. It is built field by
// field from named columns (nothing is spread) and then parsed by a strict schema, so a column added to `invoices`
// later never reaches a customer's PDF until it is named here.
//
// Everything on the page comes from the frozen issued row: seller and buyer from the snapshots taken at issue, the BS
// date from `issue_date_bs`. Nothing is read from settings or the customer record, so a later change to either
// cannot alter what a reprint says. Only an issued invoice is drawn: a tax invoice, a proforma, a credit note or a debit note.
import type { invoiceLines, invoices, invoiceTaxSummary } from '@bos/db';
import { z } from 'zod';

type Row<T extends { $inferSelect: object }> = T['$inferSelect'];

/** The kinds this unit prints. */
export const RENDERABLE_INVOICE_KINDS = [
  'tax_invoice',
  'proforma',
  'credit_note',
  'debit_note',
] as const;
export type RenderableInvoiceKind = (typeof RENDERABLE_INVOICE_KINDS)[number];

const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const party = z.strictObject({
  legalName: z.string().min(1),
  panVatNo: z.string().nullable(),
  address: z.string().nullable(),
});

export const InvoiceRenderViewSchema = z.strictObject({
  kind: z.enum(RENDERABLE_INVOICE_KINDS),
  number: z.string().min(1),
  issueDate: z.iso.date(),
  issueDateBs: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.iso.date().nullable(),
  currency: z.enum(['NPR', 'INR', 'USD']),
  seller: party,
  buyer: party,
  /**
   * null on the original. On the n-th reprint it is n, printed as "Copy of original (n)". The print log numbers the
   * original 1, so `copyNo = print_no - 1`.
   */
  copyNo: z.number().int().min(1).nullable(),
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: z.string(),
      unitPrice: money,
      amount: money,
    }),
  ),
  totals: z.strictObject({
    subtotal: money,
    discountAmount: money,
    taxableAmount: money,
    exemptAmount: money,
    zeroRatedAmount: money,
    taxAmount: money,
    total: money,
  }),
  /** `percent` is the VAT percentage, for example "13". */
  taxSummary: z.array(
    z.strictObject({ label: z.string(), percent: z.string(), base: money, tax: money }),
  ),
});
export type InvoiceRenderView = z.infer<typeof InvoiceRenderViewSchema>;

/** The columns of an invoice the mapper reads. Everything else on the row is never touched. */
export type InvoiceViewHead = Pick<
  Row<typeof invoices>,
  | 'kind'
  | 'status'
  | 'number'
  | 'issueDate'
  | 'issueDateBs'
  | 'dueDate'
  | 'currency'
  | 'subtotal'
  | 'discountAmount'
  | 'taxableVatAmount'
  | 'exemptAmount'
  | 'zeroRatedAmount'
  | 'taxAmount'
  | 'total'
  | 'sellerSnapshot'
  | 'buyerSnapshot'
>;

export interface InvoiceViewInput {
  invoice: InvoiceViewHead;
  lines: readonly Pick<
    Row<typeof invoiceLines>,
    'lineNo' | 'description' | 'uom' | 'quantity' | 'unitPrice' | 'gross'
  >[];
  taxSummary: readonly Pick<Row<typeof invoiceTaxSummary>, 'label' | 'rate' | 'base' | 'tax'>[];
  /** The number this print will get in `invoice_print_log`: 1 for the original, 2 for the first reprint. */
  printNo: number;
}

/** The invoice is not one this unit prints (not issued). */
export class InvoiceNotRenderableError extends Error {
  readonly kind = 'not_renderable';
  constructor(reason: string) {
    super(`The invoice cannot be rendered: ${reason}`);
    this.name = 'InvoiceNotRenderableError';
  }
}

/** numeric(18,4) and numeric(7,4) come back padded ("12.0000", "13.0000"); show "12" and "13", keep "2.5". */
const trimZeros = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

const isRenderable = (kind: string): kind is RenderableInvoiceKind =>
  (RENDERABLE_INVOICE_KINDS as readonly string[]).includes(kind);

/**
 * The file name of an invoice PDF. Numbers carry the fiscal year as `2083/84`, and the documents module takes a bare
 * file name only (no path separator), so each `/` becomes `-`: INV-2083/84-00001 is INV-2083-84-00001.pdf, and its
 * first reprint is INV-2083-84-00001-copy1.pdf.
 */
export function invoicePdfFilename(number: string, copyNo: number | null): string {
  const base = number.replaceAll('/', '-');
  return copyNo === null ? `${base}.pdf` : `${base}-copy${copyNo}.pdf`;
}

export function toInvoiceRenderView(input: InvoiceViewInput): InvoiceRenderView {
  const { invoice } = input;
  if (invoice.status !== 'issued') throw new InvoiceNotRenderableError(`it is ${invoice.status}`);
  if (!isRenderable(invoice.kind))
    throw new InvoiceNotRenderableError(`kind ${String(invoice.kind)}`);
  if (!Number.isInteger(input.printNo) || input.printNo < 1) {
    throw new InvoiceNotRenderableError('the print number is not a positive integer');
  }
  const { number, issueDate, issueDateBs } = invoice;
  if (number === null || issueDate === null || issueDateBs === null) {
    throw new InvoiceNotRenderableError('an issued invoice lacks its number or date');
  }

  const partyOf = (snapshot: unknown) => {
    const parsed = party.safeParse(pick(snapshot));
    if (!parsed.success) throw new InvoiceNotRenderableError('a party snapshot is malformed');
    return parsed.data;
  };

  return InvoiceRenderViewSchema.parse({
    kind: invoice.kind,
    number,
    issueDate,
    issueDateBs,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    seller: partyOf(invoice.sellerSnapshot),
    buyer: partyOf(invoice.buyerSnapshot),
    copyNo: input.printNo === 1 ? null : input.printNo - 1,
    lines: [...input.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: trimZeros(l.quantity),
        unitPrice: l.unitPrice,
        amount: l.gross,
      })),
    totals: {
      subtotal: invoice.subtotal,
      discountAmount: invoice.discountAmount,
      taxableAmount: invoice.taxableVatAmount,
      exemptAmount: invoice.exemptAmount,
      zeroRatedAmount: invoice.zeroRatedAmount,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
    },
    taxSummary: input.taxSummary.map((t) => ({
      label: t.label,
      percent: trimZeros(t.rate),
      base: t.base,
      tax: t.tax,
    })),
  });
}

/** The three party fields by name, so a snapshot that ever grew another key cannot carry it into the view. */
function pick(snapshot: unknown): unknown {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const s = snapshot as Record<string, unknown>;
  return { legalName: s.legalName, panVatNo: s.panVatNo ?? null, address: s.address ?? null };
}
