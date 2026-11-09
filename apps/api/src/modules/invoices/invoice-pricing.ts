// Pure invoice pricing (P3 unit U10): no I/O. Two entry points, both on @bos/money-rules (the one calculator, C-2):
// - `priceInvoice` prices typed lines (a manual invoice or a proforma) with `priceDocument`: gross, an optional
//   document discount spread by largest remainder, VAT once per tax code;
// - `priceSlice` cuts one invoice from a sales order's tax buckets with `invoiceSlice` (the last slice absorbs the
//   remainder), as one line per tax bucket.
// Both give the rows of invoice_lines and invoice_tax_summary and the money columns of invoices, already satisfying
// the CHECKs of 0021 (gross = round(qty x price, 2), taxable = gross - discount, total = buckets + tax). The NPR value
// is not computed here: it is frozen at issue. A foreign-currency draft is priced at a placeholder rate of 1 and only
// its document-currency figures are used.
import type { Currency, Discount } from '@bos/contracts';
import {
  CALC_VERSION,
  Dec,
  invoiceSlice,
  priceDocument,
  resolveTaxCode,
  type DiscountInput,
  type TaxBucket,
  type TaxCode,
} from '@bos/money-rules';

import type { TaxCodeRow } from '../quotations/pricing/tax-codes.resolver';

/** A tax_codes period as pricing needs it (the resolver's row). */
export type InvoiceTaxCodeRow = TaxCodeRow;

export interface InvoicePricingLine {
  catalogItemId?: string | null | undefined;
  description: string;
  uom: string;
  /** numeric(18,4) text, above zero. */
  quantity: string;
  /** numeric(18,2) text, not negative. */
  unitPrice: string;
  /** A tax_codes row id; pricing uses the period of the code in force on `asOf`. */
  taxCodeId: string;
}

export interface InvoicePricingInput {
  currency: Currency;
  /** YYYY-MM-DD: selects the tax code periods. */
  asOf: string;
  lines: InvoicePricingLine[];
  discount: Discount | null;
}

/** An invoice_lines row without keys and timestamps (`catalogItemId` has no column; it is dropped on insert). */
export interface PricedInvoiceLine {
  lineNo: number;
  catalogItemId: string | null;
  description: string;
  uom: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
  gross: string;
  discountAlloc: string;
  taxable: string;
}

/** An invoice_tax_summary row without keys: one per tax code, tax rounded once per code. */
export interface PricedInvoiceTaxRow {
  taxCodeId: string;
  label: string;
  /** Percent with 4 decimals. */
  rate: string;
  base: string;
  tax: string;
}

/** The money columns of invoices. */
export interface InvoiceColumns {
  subtotal: string;
  discountAmount: string;
  taxableVatAmount: string;
  exemptAmount: string;
  zeroRatedAmount: string;
  taxAmount: string;
  total: string;
  calcVersion: number;
}

export interface PricedInvoice {
  lines: PricedInvoiceLine[];
  taxSummary: PricedInvoiceTaxRow[];
  columns: InvoiceColumns;
}

/** A tax summary line of an order or of an invoice already cut from it. */
export interface TaxSummaryAmounts {
  taxCodeId: string;
  base: string;
  tax: string;
}

const ZERO = new Dec(0);
const money = (v: Dec): string => v.toFixed(2);
const sum = (values: readonly Dec[]): Dec => values.reduce((a, b) => a.plus(b), ZERO);

const toTaxCode = (row: InvoiceTaxCodeRow): TaxCode => ({
  code: row.code,
  kind: row.kind,
  rateBp: row.rateBp,
  creditable: row.creditable,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
});

function toDiscountInput(discount: Discount | null): DiscountInput | undefined {
  if (discount === null) return undefined;
  return discount.mode === 'pct'
    ? { kind: 'percent', percent: discount.value }
    : { kind: 'amount', amount: discount.value };
}

/** Looks up periods by id and the period of a code in force on a day. */
function periodIndex(periods: readonly InvoiceTaxCodeRow[]) {
  const byId = new Map(periods.map((p) => [p.id, p]));
  const all = periods.map(toTaxCode);
  return {
    all,
    row(id: string): InvoiceTaxCodeRow {
      const found = byId.get(id);
      if (found === undefined) throw new RangeError(`Unknown tax code id: ${id}`);
      return found;
    },
    /** The row of `code` whose period covers `asOf`. */
    inForce(code: string, asOf: string): InvoiceTaxCodeRow {
      const version = resolveTaxCode(all, code, asOf);
      const found = periods.find(
        (p) => p.code === code && p.effectiveFrom === version.effectiveFrom,
      );
      if (found === undefined) throw new RangeError(`Tax code ${code} has no period row.`);
      return found;
    },
  };
}

/** VAT base, exempt and zero-rated amounts of a document. Reverse charge is booked as exempt: no VAT is charged. */
function bucketTotals(buckets: readonly { kind: TaxCode['kind']; taxable: Dec }[]) {
  const of = (...kinds: TaxCode['kind'][]) =>
    sum(buckets.filter((b) => kinds.includes(b.kind)).map((b) => b.taxable));
  return {
    taxableVat: of('vat'),
    exempt: of('exempt', 'reverse_charge'),
    zeroRated: of('zero'),
  };
}

/** Prices typed lines. Throws RangeError for a tax code id that is not among `periods` or an out-of-range discount. */
export function priceInvoice(
  input: InvoicePricingInput,
  periods: readonly InvoiceTaxCodeRow[],
): PricedInvoice {
  const index = periodIndex(periods);
  const codes = input.lines.map((line) => index.row(line.taxCodeId).code);
  const discount = toDiscountInput(input.discount);
  const priced = priceDocument(
    {
      currency: input.currency,
      asOf: input.asOf,
      lines: input.lines.map((line, i) => ({
        qty: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: codes[i]!,
      })),
      ...(discount === undefined ? {} : { discount }),
      ...(input.currency === 'NPR' ? {} : { fxRate: '1' }),
    },
    index.all,
  );

  const lines: PricedInvoiceLine[] = input.lines.map((line, i) => {
    const p = priced.lines[i]!;
    return {
      lineNo: i + 1,
      catalogItemId: line.catalogItemId ?? null,
      description: line.description,
      uom: line.uom,
      quantity: new Dec(line.quantity).toFixed(4),
      unitPrice: new Dec(line.unitPrice).toFixed(2),
      taxCodeId: index.inForce(codes[i]!, input.asOf).id,
      gross: money(p.gross),
      discountAlloc: money(p.lineDiscount.plus(p.documentDiscountShare)),
      taxable: money(p.taxable),
    };
  });

  const taxSummary: PricedInvoiceTaxRow[] = priced.buckets.map((bucket) => {
    const row = index.inForce(bucket.taxCode.code, input.asOf);
    return {
      taxCodeId: row.id,
      label: row.name,
      rate: new Dec(row.rateBp).div(100).toFixed(4),
      base: money(bucket.taxable),
      tax: money(bucket.vat),
    };
  });

  const totals = bucketTotals(
    priced.buckets.map((b) => ({ kind: b.taxCode.kind, taxable: b.taxable })),
  );
  return {
    lines,
    taxSummary,
    columns: {
      subtotal: money(priced.subtotal),
      discountAmount: money(priced.discountTotal),
      taxableVatAmount: money(totals.taxableVat),
      exemptAmount: money(totals.exempt),
      zeroRatedAmount: money(totals.zeroRated),
      taxAmount: money(priced.vatTotal),
      total: money(priced.total),
      calcVersion: CALC_VERSION,
    },
  };
}

export interface PriceSliceInput {
  /** The schedule line's label: the description of the invoice line. */
  label: string;
  /** The schedule line's amount, VAT included. Not used for the last slice, which takes what is left. */
  sliceTotal: string;
  isLast: boolean;
  /** The sales order's tax summary. */
  soSummary: readonly TaxSummaryAmounts[];
  /** The tax summaries of the live invoices already cut from the order. */
  billed: readonly TaxSummaryAmounts[];
}

/** Cuts one invoice from a sales order: one line of quantity 1 per tax bucket, no discount (the order's is already in). */
export function priceSlice(
  input: PriceSliceInput,
  periods: readonly InvoiceTaxCodeRow[],
): PricedInvoice {
  const index = periodIndex(periods);
  const toBucket = (s: TaxSummaryAmounts): TaxBucket => ({
    taxCode: toTaxCode(index.row(s.taxCodeId)),
    taxable: new Dec(s.base),
    vat: new Dec(s.tax),
    reverseChargeVat: ZERO,
  });
  const idOfCode = new Map(input.soSummary.map((s) => [index.row(s.taxCodeId).code, s.taxCodeId]));
  const sliced = invoiceSlice(
    input.soSummary.map(toBucket),
    new Dec(input.sliceTotal),
    input.billed.map(toBucket),
    input.isLast,
  );

  const used = sliced.buckets.filter((b) => !(b.taxable.isZero() && b.vat.isZero()));
  const lines: PricedInvoiceLine[] = used.map((bucket, i) => {
    const row = index.row(idOfCode.get(bucket.taxCode.code)!);
    const taxable = money(bucket.taxable);
    return {
      lineNo: i + 1,
      catalogItemId: null,
      description: used.length > 1 ? `${input.label} - ${row.name}` : input.label,
      uom: 'lot',
      quantity: '1.0000',
      unitPrice: taxable,
      taxCodeId: row.id,
      gross: taxable,
      discountAlloc: '0.00',
      taxable,
    };
  });
  const taxSummary: PricedInvoiceTaxRow[] = used.map((bucket) => {
    const row = index.row(idOfCode.get(bucket.taxCode.code)!);
    return {
      taxCodeId: row.id,
      label: row.name,
      rate: new Dec(row.rateBp).div(100).toFixed(4),
      base: money(bucket.taxable),
      tax: money(bucket.vat),
    };
  });
  const totals = bucketTotals(
    sliced.buckets.map((b) => ({ kind: b.taxCode.kind, taxable: b.taxable })),
  );
  return {
    lines,
    taxSummary,
    columns: {
      subtotal: money(sliced.taxableTotal),
      discountAmount: '0.00',
      taxableVatAmount: money(totals.taxableVat),
      exemptAmount: money(totals.exempt),
      zeroRatedAmount: money(totals.zeroRated),
      taxAmount: money(sliced.vatTotal),
      total: money(sliced.total),
      calcVersion: CALC_VERSION,
    },
  };
}
