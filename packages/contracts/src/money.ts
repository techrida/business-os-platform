// Money as strings, never floats: a float cannot hold 0.10 exactly. Serves the NFR "amounts are exact".
import { z } from 'zod';

export const CURRENCIES = ['NPR', 'INR', 'USD'] as const;
export const CurrencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof CurrencySchema>;

/** Currencies whose NPR rate Nepal Rastra Bank fixes by peg (INR at 1.6), so an old rate row is still current. */
export const PEGGED_CURRENCIES = ['INR'] as const satisfies readonly Currency[];
export type PeggedCurrency = (typeof PEGGED_CURRENCIES)[number];

/** An amount with at most 2 decimals (numeric(18,2) in the database). Compare with decimal.js, not Number. */
export const DecimalString = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/);
export type DecimalString = z.infer<typeof DecimalString>;

/** An FX rate: up to 6 decimals (numeric(18,6)), which DecimalString would wrongly reject. */
export const RateString = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
export type RateString = z.infer<typeof RateString>;

export const MoneySchema = z.object({ amount: DecimalString, currency: CurrencySchema });
export type Money = z.infer<typeof MoneySchema>;

/** The NPR value of a foreign amount, frozen with the rate that produced it (so reports never drift). */
export const NprSnapshotSchema = z.object({
  amountNpr: DecimalString,
  rate: RateString,
  rateSource: z.string().min(1),
  /** Calendar date (YYYY-MM-DD) the rate applies to. */
  rateDate: z.iso.date(),
});
export type NprSnapshot = z.infer<typeof NprSnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// List money totals (D56 U15b-Q4)
// ---------------------------------------------------------------------------------------------

/**
 * A list endpoint keeps returning a bare array; beside X-Total-Count, this header carries the sum of the list's
 * money column over ALL matches (same scope, filters and search, not just the page), as JSON.
 */
export const MONEY_TOTALS_HEADER = 'X-Money-Totals';

/** One total per currency, never summed across currencies; currencies with no match are left out. NPR first. */
export const MoneyTotalsSchema = z.array(
  z.object({ currency: CurrencySchema, amount: DecimalString }),
);
export type MoneyTotals = z.infer<typeof MoneyTotalsSchema>;
