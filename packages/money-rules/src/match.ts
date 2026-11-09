// Three-way match for one bill line against its PO line and receipt (P4 AD6). Pure: no I/O.
import { Dec, parseDecimal, roundMoney } from './money.js';

/** A decimal string, or a Dec (a JS number never carries money). */
export type DecimalInput = string | Dec;

/**
 * The tolerance values, as settings text (`procurement.match.*`). Percentages are plain
 * percent, so "2" is 2%. `priceNpr` is a cap in NPR, so the caller passes NPR line amounts.
 */
export interface MatchTolerance {
  /** `procurement.match.qty_pct`: how far the billed quantity may exceed the received one. */
  qtyPct: string;
  /** `procurement.match.price_pct`: the price allowance as a percent of the PO line amount. */
  pricePct: string;
  /** `procurement.match.price_npr`: the price allowance cap per line; the lower of the two applies. */
  priceNpr: string;
}

/** AD6: quantity 0% over, price within 2% or NPR 500 per line (whichever is lower). */
export const DEFAULT_MATCH_TOLERANCE: MatchTolerance = {
  qtyPct: '0',
  pricePct: '2',
  priceNpr: '500',
};

export interface MatchLineInput {
  orderedQty: DecimalInput;
  receivedQty: DecimalInput;
  billedQty: DecimalInput;
  /** Unit price on the PO and on the bill, in NPR. */
  poPrice: DecimalInput;
  billPrice: DecimalInput;
  /** Tax amount for the line on the PO and on the bill, in NPR. */
  poTax: DecimalInput;
  billTax: DecimalInput;
}

export interface MatchLineResult {
  /** `billedQty - receivedQty`; above zero means billed for more than arrived. */
  qtyVariance: Dec;
  /** `receivedQty - orderedQty`, for the buyer's information; it does not fail the match. */
  orderedQtyVariance: Dec;
  /** `billPrice x billedQty - poPrice x billedQty`, each line amount rounded to 2dp half up. */
  priceVariance: Dec;
  /** `billTax - poTax` at 2dp. */
  taxVariance: Dec;
  qtyWithin: boolean;
  priceWithin: boolean;
  taxWithin: boolean;
  withinTolerance: boolean;
}

const HUNDRED = new Dec(100);

function nonNegative(value: DecimalInput, name: string): Dec {
  const parsed = value instanceof Dec ? value : parseDecimal(value);
  if (parsed.isNegative() && !parsed.isZero()) throw new RangeError(`${name} cannot be negative.`);
  return parsed;
}

/**
 * Evaluates one line. Rules (AD6):
 * - quantity: billed may not exceed received by more than `qtyPct` (0% by default);
 * - price: the line amount (price x billed quantity) may differ from the PO's by at most
 *   min(`pricePct` of the PO line amount, `priceNpr`), in either direction;
 * - tax: the two tax amounts must be equal to the paisa.
 */
export function evaluateLine(
  input: MatchLineInput,
  tolerance: MatchTolerance = DEFAULT_MATCH_TOLERANCE,
): MatchLineResult {
  const qtyPct = nonNegative(tolerance.qtyPct, 'Quantity tolerance');
  const pricePct = nonNegative(tolerance.pricePct, 'Price tolerance percent');
  const priceCap = nonNegative(tolerance.priceNpr, 'Price tolerance cap');

  const orderedQty = nonNegative(input.orderedQty, 'Ordered quantity');
  const receivedQty = nonNegative(input.receivedQty, 'Received quantity');
  const billedQty = nonNegative(input.billedQty, 'Billed quantity');
  const poPrice = nonNegative(input.poPrice, 'PO price');
  const billPrice = nonNegative(input.billPrice, 'Bill price');
  const poTax = roundMoney(nonNegative(input.poTax, 'PO tax'));
  const billTax = roundMoney(nonNegative(input.billTax, 'Bill tax'));

  const qtyVariance = billedQty.minus(receivedQty);
  const qtyAllowed = receivedQty.times(HUNDRED.plus(qtyPct)).div(HUNDRED);
  const qtyWithin = billedQty.lte(qtyAllowed);

  const poAmount = roundMoney(poPrice.times(billedQty));
  const billAmount = roundMoney(billPrice.times(billedQty));
  const priceVariance = billAmount.minus(poAmount);
  const priceAllowed = Dec.min(poAmount.times(pricePct).div(HUNDRED), priceCap);
  const priceWithin = priceVariance.abs().lte(priceAllowed);

  const taxVariance = billTax.minus(poTax);
  const taxWithin = taxVariance.isZero();

  return {
    qtyVariance,
    orderedQtyVariance: receivedQty.minus(orderedQty),
    priceVariance,
    taxVariance,
    qtyWithin,
    priceWithin,
    taxWithin,
    withinTolerance: qtyWithin && priceWithin && taxWithin,
  };
}
