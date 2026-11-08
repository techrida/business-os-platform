// Document pricing: qty x rate, line discount, header discount allocated by largest remainder,
// per-bucket VAT, NPR snapshot. One calculator for P2 quotations and P3 invoices (C-2).
import { allocateLargestRemainder } from './allocate.js';
import { effectiveDiscountPct, exceedsDiscountThreshold } from './discount.js';
import { nprSnapshot, type NprSnapshot } from './fx.js';
import {
  Dec,
  parseDecimal,
  parseMoney,
  parseQuantity,
  roundMoney,
  type Currency,
} from './money.js';
import { computeTaxBuckets, resolveTaxCode, type TaxBucket, type TaxCode } from './tax.js';
import { CALC_VERSION } from './version.js';

/** A discount entered as a percentage (0 to 100, any decimals) or as a fixed amount. */
export type DiscountInput =
  { kind: 'percent'; percent: string } | { kind: 'amount'; amount: string };

export interface LineInput {
  /** numeric(18,4), greater than zero. */
  qty: string;
  /** numeric(18,2), not negative. */
  unitPrice: string;
  /** Tax code to look up (effective-dated) as of `DocInput.asOf`. */
  taxCode: string;
  /** Line discount, taken off this line before the header discount is spread. */
  discount?: DiscountInput;
}

export interface DocInput {
  currency: Currency;
  /** ISO business date (YYYY-MM-DD) that selects the tax code versions. */
  asOf: string;
  /** At least one line. */
  lines: readonly LineInput[];
  /** Header (document) discount, allocated over the lines on line net. */
  discount?: DiscountInput;
  /** numeric(18,6) text. Required for INR and USD; absent (or 1) for NPR. */
  fxRate?: string;
}

export interface PricedLine {
  taxCode: string;
  /** round2(qty x unit price). */
  gross: Dec;
  lineDiscount: Dec;
  /** gross - lineDiscount. */
  lineNet: Dec;
  /** This line's share of the header discount (largest remainder on line net). */
  documentDiscountShare: Dec;
  /** lineNet - documentDiscountShare. */
  taxable: Dec;
  /** This line's share of its bucket's VAT (reporting only; the bucket VAT is the truth). */
  vat: Dec;
}

export interface PricedDoc {
  /** Version of the arithmetic; store it with the document. */
  calcVersion: number;
  currency: Currency;
  lines: PricedLine[];
  buckets: TaxBucket[];
  subtotal: Dec;
  lineDiscountTotal: Dec;
  documentDiscount: Dec;
  /** lineDiscountTotal + documentDiscount. */
  discountTotal: Dec;
  taxableTotal: Dec;
  vatTotal: Dec;
  /** taxableTotal + vatTotal: the grand total including VAT. */
  total: Dec;
  /** discountTotal / subtotal x 100, numeric(9,4) text. For storage and display only. */
  effectiveDiscountPct: string;
  /** True when the unrounded effective discount is strictly above 12%. */
  discountApprovalRequired: boolean;
  /** NPR figures (C-2): total and VAT rounded, taxable = total - VAT. */
  npr: NprSnapshot;
  /** The approval-threshold amount (C-6): `npr.totalNpr`. */
  amountNpr: Dec;
}

// numeric(18,2) holds amounts below 10^16.
const NUMERIC_18_2_LIMIT = new Dec('1e16');
const HUNDRED = new Dec(100);
const ZERO = new Dec(0);

function assertFits(value: Dec, label: string): void {
  if (value.abs().gte(NUMERIC_18_2_LIMIT))
    throw new RangeError(`${label} does not fit numeric(18,2).`);
}

/** Resolves a discount against a base amount: the rounded amount applied (0 <= amount <= base). */
function applyDiscount(discount: DiscountInput | undefined, base: Dec, label: string): Dec {
  if (discount === undefined) return ZERO;
  if (discount.kind === 'percent') {
    const percent = parseDecimal(discount.percent);
    if (percent.isNegative() || percent.gt(HUNDRED)) {
      throw new RangeError(`${label}: a percentage must be from 0 to 100.`);
    }
    return roundMoney(base.times(percent).div(HUNDRED));
  }
  const amount = parseDecimal(discount.amount);
  if (amount.decimalPlaces() > 2)
    throw new RangeError(`${label}: an amount has more than 2 decimals.`);
  if (amount.isNegative() || amount.gt(base)) {
    throw new RangeError(`${label}: an amount must be from 0 to ${base.toFixed(2)}.`);
  }
  return amount;
}

const sum = (values: readonly Dec[]): Dec => values.reduce((a, b) => a.plus(b), ZERO);

/**
 * Prices a document. Pure: strings in, Decimals out, no float anywhere.
 *
 * 1. gross = round2(qty x unit price) per line.
 * 2. Line discount (percentage or amount, 0 to gross; out of range is rejected, not capped).
 * 3. Header discount D on the sum of line net, allocated over the lines on line net by largest
 *    remainder, so the shares add up to D exactly.
 * 4. taxable = line net - share. VAT once per tax code bucket (see `computeTaxBuckets`).
 * 5. total = taxable + VAT. NPR total and VAT rounded, NPR taxable = total - VAT (C-2).
 * 6. Effective discount % = all discounts / subtotal, compared with 12 unrounded (strict >).
 */
export function priceDocument(input: DocInput, taxCodes: readonly TaxCode[]): PricedDoc {
  if (input.lines.length === 0) throw new RangeError('A document needs at least one line.');

  const grossAmounts: Dec[] = [];
  const lineDiscounts: Dec[] = [];
  input.lines.forEach((line, index) => {
    const unitPrice = parseMoney(line.unitPrice);
    if (unitPrice.isNegative()) throw new RangeError(`Line ${index + 1}: unit price is negative.`);
    const gross = roundMoney(parseQuantity(line.qty).times(unitPrice));
    grossAmounts.push(gross);
    lineDiscounts.push(applyDiscount(line.discount, gross, `Line ${index + 1} discount`));
  });
  const lineNets = grossAmounts.map((gross, i) => gross.minus(lineDiscounts[i]!));

  const documentDiscount = applyDiscount(input.discount, sum(lineNets), 'Document discount');
  const shares = allocateLargestRemainder(documentDiscount, lineNets);
  const taxables = lineNets.map((net, i) => net.minus(shares[i]!));

  const resolved = input.lines.map((line) => resolveTaxCode(taxCodes, line.taxCode, input.asOf));
  const { buckets, lineVat } = computeTaxBuckets(
    taxables.map((taxable, i) => ({ taxable, taxCode: resolved[i]! })),
  );

  const subtotal = sum(grossAmounts);
  const lineDiscountTotal = sum(lineDiscounts);
  const discountTotal = lineDiscountTotal.plus(documentDiscount);
  const taxableTotal = sum(taxables);
  const vatTotal = sum(buckets.map((b) => b.vat));
  const total = taxableTotal.plus(vatTotal);
  assertFits(subtotal, 'Subtotal');
  assertFits(total, 'Total');

  const npr = nprSnapshot({
    total,
    vat: vatTotal,
    currency: input.currency,
    ...(input.fxRate === undefined ? {} : { fxRate: input.fxRate }),
  });

  return {
    calcVersion: CALC_VERSION,
    currency: input.currency,
    lines: input.lines.map((line, i) => ({
      taxCode: line.taxCode,
      gross: grossAmounts[i]!,
      lineDiscount: lineDiscounts[i]!,
      lineNet: lineNets[i]!,
      documentDiscountShare: shares[i]!,
      taxable: taxables[i]!,
      vat: lineVat[i]!,
    })),
    buckets,
    subtotal,
    lineDiscountTotal,
    documentDiscount,
    discountTotal,
    taxableTotal,
    vatTotal,
    total,
    effectiveDiscountPct: effectiveDiscountPct(discountTotal, subtotal),
    discountApprovalRequired: exceedsDiscountThreshold(discountTotal, subtotal),
    npr,
    amountNpr: npr.totalNpr,
  };
}
