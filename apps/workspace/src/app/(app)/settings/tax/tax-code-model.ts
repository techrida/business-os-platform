// Words and dates for the VAT codes table on Settings > Tax. Plain data, no React, so the table, its dialogs and
// the tests share one source.
import type { AdminTaxCode, TaxCodeKind } from '@bos/contracts';

export const KIND_LABEL: Record<TaxCodeKind, string> = {
  vat: 'VAT',
  exempt: 'Exempt',
  zero: 'Zero-rated',
  reverse_charge: 'Reverse charge',
};

export const KIND_OPTIONS: readonly { value: TaxCodeKind; label: string }[] = (
  Object.keys(KIND_LABEL) as TaxCodeKind[]
).map((value) => ({ value, label: KIND_LABEL[value] }));

/** A kind whose rate is always 0: the rate field is fixed at 0 for it. */
export const isZeroRateKind = (kind: TaxCodeKind): boolean => kind === 'exempt' || kind === 'zero';

/** `day` (YYYY-MM-DD) moved by `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * The first day a change or a retirement may take effect: today, or the day after the last period started when
 * that is later (a period that starts today cannot also end today).
 */
export function firstEditableDay(code: AdminTaxCode, today: string): string {
  const afterStart = addDays(code.latest.effectiveFrom, 1);
  return afterStart > today ? afterStart : today;
}

/** True once the code has an end day: it takes no change and cannot be retired again. */
export const isClosed = (code: AdminTaxCode): boolean => code.endsOn !== null;

/** The rate shown in the table: the one in force today, else the first one to come. */
export function shownRate(code: AdminTaxCode): string {
  const period = code.current ?? code.next ?? code.latest;
  return `${period.rate}%`;
}

/** One line on where the code stands today, in plain words. */
export function statusText(code: AdminTaxCode, today: string): string {
  if (code.endsOn !== null && code.endsOn <= today) return `Retired from ${code.endsOn}`;
  if (code.current === null)
    return `Starts ${code.periods[0]?.effectiveFrom ?? code.latest.effectiveFrom}`;
  if (code.next !== null) return `Changes to ${code.next.rate}% on ${code.next.effectiveFrom}`;
  if (code.endsOn !== null) return `Not offered from ${code.endsOn}`;
  return 'In use';
}
