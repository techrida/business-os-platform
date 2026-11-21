// The digit limits of every numeric string the contracts take, written once. The patterns below are built from
// them, and the number inputs import the same constants, so a field can never accept what the schema refuses.

/** How many whole digits and decimals a plain decimal string may have. */
export interface NumberLimits {
  readonly intDigits: number;
  readonly scale: number;
}

/** numeric(18,2): 16 whole digits and 2 decimals. */
export const MONEY_LIMITS: NumberLimits = { intDigits: 16, scale: 2 };
/** numeric(18,6): an FX rate. */
export const RATE_LIMITS: NumberLimits = { intDigits: 12, scale: 6 };
/** numeric(18,4): a quantity. */
export const QUANTITY_LIMITS: NumberLimits = { intDigits: 14, scale: 4 };
/** numeric(7,4): a percentage or tax rate. */
export const PERCENT_LIMITS: NumberLimits = { intDigits: 3, scale: 4 };

/**
 * The pattern for a plain decimal string with these limits: no grouping, no exponent, at least one whole digit.
 * `signed` allows a leading minus.
 */
export function decimalPattern(limits: NumberLimits, opts?: { signed?: boolean }): RegExp {
  const fraction = limits.scale > 0 ? `(\\.\\d{1,${limits.scale}})?` : '';
  return new RegExp(`^${opts?.signed ? '-?' : ''}\\d{1,${limits.intDigits}}${fraction}$`);
}
