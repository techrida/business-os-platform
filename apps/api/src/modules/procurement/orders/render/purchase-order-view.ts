// The allow-list a purchase order PDF is drawn from (P4 unit P3b). The template is given this view and nothing else, so
// it cannot print an NPR value, an FX rate, a band, an approval, a comparison score or an internal note. It is built
// field by field from named values (nothing is spread) and then parsed by a strict schema, so a field added to the
// PO snapshot later never reaches a vendor's PDF until it is named here.
//
// The lines, the totals and the header terms come from the version's frozen snapshot (purchase_order_versions is
// immutable), never from the live purchase_order_lines: an amendment moves the live lines, and a reprint of version 1
// must still say version 1. Only the names that are not in the snapshot (the vendor, the buying entity, the tax code
// labels, the delivery terms of the request) are read when the version is rendered.
import { PurchaseOrderAdvancePercentSchema, trimPercent } from '@bos/contracts';
import { Dec, formatBs, kathmanduDate } from '@bos/locale';
import { z } from 'zod';

const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const party = z.strictObject({
  legalName: z.string().min(1),
  panVatNo: z.string().nullable(),
});

export const PurchaseOrderRenderViewSchema = z.strictObject({
  number: z.string().min(1),
  version: z.number().int().min(1),
  /** The Kathmandu calendar day the version was issued. */
  issueDate: z.iso.date(),
  /** `YYYY-MM-DD` in Bikram Sambat; null for a day outside the converter's range. */
  issueDateBs: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  currency: z.enum(['NPR', 'INR', 'USD']),
  buyer: party,
  vendor: party,
  paymentTermsDays: z.number().int().min(0),
  /** null when no advance is due; "25" for 25 percent. */
  advancePercent: PurchaseOrderAdvancePercentSchema.nullable(),
  requiredBy: z.iso.date().nullable(),
  deliveryLocation: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: z.string(),
      unitPrice: money,
      taxCode: z.string().min(1),
      amount: money,
      taxAmount: money,
    }),
  ),
  totals: z.strictObject({ subtotal: money, taxAmount: money, total: money }),
  taxSummary: z.array(z.strictObject({ code: z.string().min(1), base: money, tax: money })),
});
export type PurchaseOrderRenderView = z.infer<typeof PurchaseOrderRenderViewSchema>;

/**
 * The parts of a version snapshot the PDF reads. These objects are not strict on purpose: anything else in the
 * snapshot (fx rate, links to the request) is dropped here, and the view is built from these named keys.
 */
const SnapshotSchema = z.object({
  purchaseOrder: z.object({
    number: z.string().min(1),
    currency: z.enum(['NPR', 'INR', 'USD']),
    paymentTermsDays: z.number().int().min(0),
    advancePercent: PurchaseOrderAdvancePercentSchema,
  }),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().min(1),
        description: z.string(),
        uom: z.string(),
        orderedQuantity: z.string(),
        unitPrice: money,
        taxCodeId: z.string(),
        gross: money,
        taxAmount: money,
      }),
    )
    .min(1),
});

/** The tax code ids a snapshot names, or none when it is malformed (the mapper then refuses it). */
export function taxCodeIdsOf(snapshot: unknown): string[] {
  const parsed = SnapshotSchema.safeParse(snapshot);
  return parsed.success ? [...new Set(parsed.data.lines.map((l) => l.taxCodeId))] : [];
}

export interface PurchaseOrderViewInput {
  version: { version: number; createdAt: Date; total: string; snapshot: unknown };
  buyer: { legalName: string; panVatNo: string | null };
  vendor: { legalName: string; pan: string | null };
  delivery: { requiredBy: string | null; deliveryLocation: string | null };
  /** Tax code id -> its code (for example `VAT13`). */
  taxCodes: ReadonlyMap<string, string>;
}

/** The version is not one this unit can draw (a snapshot that does not fit, totals that do not add up). */
export class PurchaseOrderNotRenderableError extends Error {
  readonly kind = 'not_renderable';
  constructor(reason: string) {
    super(`The purchase order version cannot be rendered: ${reason}`);
    this.name = 'PurchaseOrderNotRenderableError';
  }
}

/** Quantities come back padded ("12.5000"); show "12.5". */
const trimZeros = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

/**
 * The file name of a PO PDF. Numbers carry the fiscal year as `2083/84`, and the documents module takes a bare file
 * name only (no path separator), so each `/` becomes `-`: PO-2083/84-00007 version 2 is PO-2083-84-00007-v2.pdf.
 */
export function purchaseOrderPdfFilename(number: string, version: number): string {
  return `${number.replaceAll('/', '-')}-v${version}.pdf`;
}

export function toPurchaseOrderRenderView(input: PurchaseOrderViewInput): PurchaseOrderRenderView {
  const parsed = SnapshotSchema.safeParse(input.version.snapshot);
  if (!parsed.success) throw new PurchaseOrderNotRenderableError('the snapshot is malformed');
  const { purchaseOrder: po } = parsed.data;

  const lines = [...parsed.data.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => {
      const taxCode = input.taxCodes.get(l.taxCodeId);
      if (taxCode === undefined) throw new PurchaseOrderNotRenderableError('a tax code is missing');
      return {
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity: trimZeros(l.orderedQuantity),
        unitPrice: l.unitPrice,
        taxCode,
        amount: l.gross,
        taxAmount: l.taxAmount,
      };
    });

  const subtotal = lines.reduce((sum, l) => sum.plus(l.amount), new Dec(0));
  const tax = lines.reduce((sum, l) => sum.plus(l.taxAmount), new Dec(0));
  if (!subtotal.plus(tax).equals(new Dec(input.version.total))) {
    throw new PurchaseOrderNotRenderableError('the lines do not add up to the version total');
  }

  const byCode = new Map<string, { base: Dec; tax: Dec }>();
  for (const l of lines) {
    const row = byCode.get(l.taxCode) ?? { base: new Dec(0), tax: new Dec(0) };
    byCode.set(l.taxCode, { base: row.base.plus(l.amount), tax: row.tax.plus(l.taxAmount) });
  }

  const { y, m, d } = kathmanduDate(input.version.createdAt);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  let issueDateBs: string | null = null;
  try {
    issueDateBs = formatBs(input.version.createdAt, 'YYYY-MM-DD');
  } catch (error) {
    // Outside the converter's range (BS 2000 to 2090): the Gregorian date stands alone.
    if (!(error instanceof RangeError)) throw error;
  }

  const advance = trimPercent(po.advancePercent);
  return PurchaseOrderRenderViewSchema.parse({
    number: po.number,
    version: input.version.version,
    issueDate: `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`,
    issueDateBs,
    currency: po.currency,
    buyer: { legalName: input.buyer.legalName, panVatNo: input.buyer.panVatNo },
    vendor: { legalName: input.vendor.legalName, panVatNo: input.vendor.pan },
    paymentTermsDays: po.paymentTermsDays,
    advancePercent: new Dec(advance).isZero() ? null : advance,
    requiredBy: input.delivery.requiredBy,
    deliveryLocation: input.delivery.deliveryLocation,
    lines,
    totals: {
      subtotal: subtotal.toFixed(2),
      taxAmount: tax.toFixed(2),
      total: new Dec(input.version.total).toFixed(2),
    },
    taxSummary: [...byCode]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([code, row]) => ({ code, base: row.base.toFixed(2), tax: row.tax.toFixed(2) })),
  });
}
