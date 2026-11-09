// TDS (tax deducted at source) on a vendor bill and the amount actually payable (P4 AD14).
import { Dec, parseDecimal, roundMoney } from './money.js';

const BP_DIVISOR = new Dec(10000);

function asDec(value: string | Dec): Dec {
  return value instanceof Dec ? value : parseDecimal(value);
}

/**
 * TDS on the net amount, which excludes VAT: `net x rateBp / 10,000`, rounded half up to 2dp.
 * The rate is an integer number of basis points (150 = 1.5%); a code at zero gives zero TDS.
 */
export function tdsFor(net: string | Dec, rateBp: number): Dec {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    throw new RangeError(`TDS rate must be an integer from 0 to 10000 basis points: ${rateBp}`);
  }
  return roundMoney(asDec(net).times(rateBp).div(BP_DIVISOR));
}

/** What the vendor is paid: `net + vat - tds`, at 2dp. TDS is withheld, VAT is not. */
export function payableTotal(input: {
  net: string | Dec;
  vat: string | Dec;
  tds: string | Dec;
}): Dec {
  return roundMoney(asDec(input.net).plus(asDec(input.vat)).minus(asDec(input.tds)));
}
