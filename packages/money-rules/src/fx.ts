// NPR snapshot and the approval-threshold amount (C-2, C-6).
import { Dec, parseDecimal, parseFxRate, roundMoney, type Currency } from './money.js';

/**
 * The basis of `amountNpr` (C-6, recommended default pending Kuu's decision): the grand total
 * including VAT, in NPR, before TDS. One basis for every document type; the comparison is a
 * strict ">". TDS is deliberately not an input, so it cannot move the figure.
 */
export const AMOUNT_NPR_BASIS = 'grand_total_incl_vat_before_tds';

const ONE = new Dec(1);

/** The rate to apply: 1 for NPR (a rate is optional and must then be 1); required otherwise. */
function resolveRate(currency: Currency, fxRate: string | undefined): Dec {
  if (currency === 'NPR') {
    if (fxRate !== undefined && !parseFxRate(fxRate).eq(ONE)) {
      throw new RangeError('An NPR document has no exchange rate (it must be 1 or absent).');
    }
    return ONE;
  }
  if (fxRate === undefined) throw new RangeError(`A ${currency} document needs an FX rate.`);
  return parseFxRate(fxRate);
}

/** Converts a document-currency amount to NPR: amount x rate, rounded half up to 2dp. */
export function toNpr(amount: Dec, currency: Currency, fxRate?: string): Dec {
  return roundMoney(amount.times(resolveRate(currency, fxRate)));
}

export interface NprSnapshot {
  /** The rate used, numeric(18,6) text. */
  fxRate: string;
  totalNpr: Dec;
  vatNpr: Dec;
  /** `totalNpr - vatNpr`, so the NPR figures add up exactly (C-2). */
  taxableNpr: Dec;
}

/**
 * C-2: the NPR total and the NPR VAT are each rounded, and the taxable amount is their
 * difference. Converting the taxable amount on its own could be a paisa off, which would break
 * "total = taxable + VAT" in the NPR journal.
 */
export function nprSnapshot(input: {
  total: Dec;
  vat: Dec;
  currency: Currency;
  fxRate?: string;
}): NprSnapshot {
  const rate = resolveRate(input.currency, input.fxRate);
  const totalNpr = roundMoney(input.total.times(rate));
  const vatNpr = roundMoney(input.vat.times(rate));
  return { fxRate: rate.toFixed(6), totalNpr, vatNpr, taxableNpr: totalNpr.minus(vatNpr) };
}

/** The threshold amount in NPR for a document: its grand total including VAT, before TDS. */
export function amountNpr(input: { total: Dec; currency: Currency; fxRate?: string }): Dec {
  return toNpr(input.total, input.currency, input.fxRate);
}

/** True when `amount` is strictly greater than `thresholdNpr` (a band edge is not above itself). */
export function exceedsApprovalThresholdNpr(amount: Dec, thresholdNpr: string): boolean {
  return amount.gt(parseDecimal(thresholdNpr));
}
