// The allow-list a purchase order PDF is drawn from (P4 unit P3b). The template is given this view and nothing else, so
// it cannot print an NPR value, an FX rate, a band, an approval, a comparison score or an internal note. It is built
// field by field from named values (nothing is spread) and then parsed by a strict schema, so a field added to the
// PO snapshot later never reaches a vendor's PDF until it is named here.
//
// The lines, the totals and the header terms come from the version's frozen snapshot (purchase_order_versions is
// immutable), never from the live purchase_order_lines: an amendment moves the live lines, and a reprint of version 1
// must still say version 1. Only the names that are not in the snapshot (the vendor with its address and primary
// phone, the buying entity and its country, the tax code labels, the delivery terms of the request) are read when the
// version is rendered.
//
// The vendor's address prints as lines (street, city, country name), the country left out when it is the buying
// entity's own (FX9). The phone is the vendor's primary contact's primary number, in the FX8 print format for a Nepal
// number and international format for a foreign one.
import {
  formatAddressLines,
  formatPartyPhoneForPrint,
  isCountryCode,
  PurchaseOrderAdvancePercentSchema,
  trimPercent,
  type CountryCode,
} from '@bos/contracts';
import { Dec, formatBs, kathmanduDate } from '@bos/locale';
import { z } from 'zod';

const money = z.string().regex(/^-?\d+(\.\d+)?$/);
const party = z.strictObject({
  legalName: z.string().min(1),
  panVatNo: z.string().nullable(),
});
const vendorParty = z.strictObject({
  legalName: z.string().min(1),
  panVatNo: z.string().nullable(),
  /** Street, city and (unless it is the buyer's own) the country's name; empty when the vendor has no address. */
  addressLines: z.array(z.string().min(1)),
  /** The primary contact's primary number as printed; null when there is none. */
  phone: z.string().min(1).nullable(),
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
  vendor: vendorParty,
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
  /** `country`: the entity's own (`entity.address`); null when unset, and then a vendor's country always prints. */
  buyer: { legalName: string; panVatNo: string | null; country: CountryCode | null };
  vendor: {
    legalName: string;
    pan: string | null;
    /** ISO 3166-1 alpha-2, as stored. */
    country: string;
    /** Set together with addressCity or not at all (vendors CHECK). */
    addressLine: string | null;
    addressCity: string | null;
    /** The primary contact's primary phone, E.164; null when the vendor has none. */
    phoneE164: string | null;
  };
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

  const { vendor } = input;
  if (!isCountryCode(vendor.country)) {
    throw new PurchaseOrderNotRenderableError('the vendor country is not known');
  }
  const addressLines =
    vendor.addressLine !== null && vendor.addressCity !== null
      ? formatAddressLines(
          { line: vendor.addressLine, city: vendor.addressCity },
          vendor.country,
          input.buyer.country ?? undefined,
        )
      : [];

  const advance = trimPercent(po.advancePercent);
  return PurchaseOrderRenderViewSchema.parse({
    number: po.number,
    version: input.version.version,
    issueDate: `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`,
    issueDateBs,
    currency: po.currency,
    buyer: { legalName: input.buyer.legalName, panVatNo: input.buyer.panVatNo },
    vendor: {
      legalName: vendor.legalName,
      panVatNo: vendor.pan,
      addressLines,
      phone: vendor.phoneE164 === null ? null : formatPartyPhoneForPrint(vendor.phoneE164),
    },
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
