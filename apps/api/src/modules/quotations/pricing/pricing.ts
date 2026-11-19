// Pure quotation pricing: maps @bos/money-rules priceDocument (the one calculator, C-2) onto the quotation
// tables. No I/O; the service resolves tax code periods and the FX rate first. priceDocument already satisfies
// the DB CHECKs (taxable = subtotal - discount, total = taxable + tax, gross = round(qty x price, 2),
// line taxable = gross - allocation); this file only renames and formats, so keep arithmetic out of it except
// the internal cost and margin, which money-rules does not know about.
import {
  Dec,
  parseMoney,
  parseQuantity,
  priceDocument,
  resolveTaxCode,
  roundMoney,
  toNpr,
  type DiscountInput,
  type PricedDoc,
  type TaxCode,
} from '@bos/money-rules';

import type {
  PricedColumns,
  PricedVersion,
  PricingInput,
  QuoteFacts,
  TaxSummaryRow,
} from './pricing.types';
import type { TaxCodeRow } from './tax-codes.resolver';

/** The rate that converts the quotation to NPR. NPR: rate 1 with no source or date. */
export interface FxSnapshot {
  rate: string;
  source: string | null;
  date: string | null;
}

const HUNDRED = new Dec(100);
/** The widest margin that fits both margin_pct numeric(9,4) and the approval snapshot regex (3 integer digits). */
const MARGIN_LIMIT = new Dec('999.9999');
const ZERO = new Dec(0);
const money = (value: Dec): string => value.toFixed(2);

function toDiscountInput(discount: PricingInput['discount']): DiscountInput | undefined {
  if (discount === null) return undefined;
  return discount.mode === 'pct'
    ? { kind: 'percent', percent: discount.value }
    : { kind: 'amount', amount: discount.value };
}

/** discount / subtotal x 100 at full precision ('0' for a zero subtotal): the fact the 12% rule reads. */
function unroundedDiscountPct(priced: PricedDoc): string {
  if (priced.subtotal.isZero()) return '0';
  return priced.discountTotal.times(HUNDRED).div(priced.subtotal).toFixed();
}

interface Margin {
  internalCostTotal: string | null;
  marginPct: string | null;
  /** True when a margin was computed but lies beyond -999.9999 (it is then stored and reported as null). */
  marginOutOfRange: boolean;
}

/**
 * Internal cost and margin (architect section 2.6 step 8): only when every line has a unit cost. A margin can
 * only exceed the limit downwards (cost above about 11x taxable), since it is at most 100%.
 */
function marginOf(input: PricingInput, taxableTotal: Dec): Margin {
  const costs = input.lines.map((line) => line.unitCost ?? null);
  if (costs.some((cost) => cost === null)) {
    return { internalCostTotal: null, marginPct: null, marginOutOfRange: false };
  }
  const cost = input.lines.reduce(
    (sum, line) =>
      sum.plus(roundMoney(parseQuantity(line.quantity).times(parseMoney(line.unitCost!)))),
    ZERO,
  );
  const internalCostTotal = money(cost);
  if (taxableTotal.isZero()) return { internalCostTotal, marginPct: null, marginOutOfRange: false };
  const margin = taxableTotal
    .minus(cost)
    .times(HUNDRED)
    .div(taxableTotal)
    .toDecimalPlaces(4, Dec.ROUND_HALF_UP);
  if (margin.abs().gt(MARGIN_LIMIT)) {
    return { internalCostTotal, marginPct: null, marginOutOfRange: true };
  }
  return { internalCostTotal, marginPct: margin.toFixed(4), marginOutOfRange: false };
}

/** The facts the approval provider and the UI read; never derived from rounded text. */
export function buildFacts(
  priced: PricedDoc,
  currency: PricingInput['currency'],
  margin: Pick<Margin, 'marginPct' | 'marginOutOfRange'>,
): QuoteFacts {
  return {
    amountNpr: money(priced.amountNpr),
    // Same rate and rounding (roundMoney) as the C-2 snapshot; for NPR the rate is 1, so this is the discount.
    nprDiscountAmount: money(toNpr(priced.discountTotal, currency, priced.npr.fxRate)),
    effectiveDiscountPct: unroundedDiscountPct(priced),
    discountApprovalRequired: priced.discountApprovalRequired,
    marginPct: margin.marginPct,
    marginOutOfRange: margin.marginOutOfRange,
    currency,
  };
}

/**
 * Prices one quotation version. `periods` must hold every period of each code the lines name (see
 * loadTaxCodePeriods); the period in force on `issueDate` is the one stored on the line and the summary.
 * Throws RangeError on invalid input (unknown tax code, no period in force, discount out of range).
 */
export function priceQuotation(
  input: PricingInput,
  periods: readonly TaxCodeRow[],
  fx: FxSnapshot,
): PricedVersion {
  // One TaxCode object per period; resolveTaxCode returns the object it was given, so this map recovers the row.
  const rowOf = new Map<TaxCode, TaxCodeRow>();
  const taxCodes: TaxCode[] = periods.map((row) => {
    const code: TaxCode = {
      code: row.code,
      kind: row.kind,
      rateBp: row.rateBp,
      creditable: row.creditable,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
    rowOf.set(code, row);
    return code;
  });
  const codeOf = new Map(periods.map((row) => [row.id, row.code]));

  const lineCodes = input.lines.map((line) => {
    const code = codeOf.get(line.taxCodeId);
    if (code === undefined) throw new RangeError(`Unknown tax code: ${line.taxCodeId}`);
    return code;
  });
  const discount = toDiscountInput(input.discount);
  const priced = priceDocument(
    {
      currency: input.currency,
      asOf: input.issueDate,
      lines: input.lines.map((line, i) => ({
        qty: line.quantity,
        unitPrice: line.unitPrice,
        taxCode: lineCodes[i]!,
      })),
      ...(discount === undefined ? {} : { discount }),
      ...(input.currency === 'NPR' ? {} : { fxRate: fx.rate }),
    },
    taxCodes,
  );

  const periodFor = (code: string): TaxCodeRow =>
    rowOf.get(resolveTaxCode(taxCodes, code, input.issueDate))!;

  const lines = input.lines.map((line, i) => {
    const p = priced.lines[i]!;
    return {
      lineNo: line.lineNo,
      catalogItemId: line.catalogItemId ?? null,
      description: line.description,
      uom: line.uom,
      quantity: parseQuantity(line.quantity).toFixed(4),
      unitPrice: money(parseMoney(line.unitPrice)),
      unitCost: line.unitCost == null ? null : money(parseMoney(line.unitCost)),
      taxCodeId: periodFor(lineCodes[i]!).id,
      gross: money(p.gross),
      discountAlloc: money(p.documentDiscountShare),
      taxable: money(p.taxable),
    };
  });

  const taxSummary: TaxSummaryRow[] = priced.buckets.map((bucket) => {
    const row = rowOf.get(bucket.taxCode)!;
    return {
      taxCodeId: row.id,
      label: row.name,
      rate: new Dec(row.rateBp).div(HUNDRED).toFixed(4),
      base: money(bucket.taxable),
      tax: money(bucket.vat),
    };
  });

  const margin = marginOf(input, priced.taxableTotal);
  const { internalCostTotal, marginPct } = margin;
  const foreign = input.currency !== 'NPR';
  const columns: PricedColumns = {
    subtotal: money(priced.subtotal),
    discountAmount: money(priced.discountTotal),
    taxableAmount: money(priced.taxableTotal),
    taxAmount: money(priced.vatTotal),
    total: money(priced.total),
    effectiveDiscountPct: priced.effectiveDiscountPct,
    amountNpr: money(priced.npr.totalNpr),
    nprTaxableAmount: money(priced.npr.taxableNpr),
    fxRate: priced.npr.fxRate,
    fxSource: foreign ? fx.source : null,
    fxDate: foreign ? fx.date : null,
    calcVersion: priced.calcVersion,
    internalCostTotal,
    marginPct,
  };

  return { lines, taxSummary, columns, facts: buildFacts(priced, input.currency, margin) };
}
