// Receivable state derived from allocations (P3 A8: never stored), AR aging, and the NPR side
// of an allocation (A13: same currency; the FX difference goes only into the posting payload).
import { Dec, parseFxRate, roundMoney } from './money.js';

export type Settlement = 'unpaid' | 'partly_paid' | 'paid' | 'overdue' | 'credited';

/** AR aging buckets (R10), in report order. */
export const AGING_BUCKETS = ['current', '1-15', '16-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const ZERO = new Dec(0);
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for an ISO `YYYY-MM-DD` calendar date; throws on anything else. */
function dayNumber(value: string, label: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match !== null) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const time = Date.UTC(y, m - 1, d);
    const date = new Date(time);
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) {
      return time / DAY_MS;
    }
  }
  throw new RangeError(`${label} is not a calendar date (YYYY-MM-DD): ${value}`);
}

function assertAmount(value: Dec, label: string): void {
  if (value.isNegative()) throw new RangeError(`${label} must not be negative.`);
  if (value.decimalPlaces() > 2) throw new RangeError(`${label} has more than 2 decimals.`);
}

/**
 * The aging bucket of a receivable: days past due = `today - dueDate` (ISO business dates; the
 * caller picks "today" in Asia/Kathmandu). Not yet due or due today is `current`.
 */
export function agingBucket(dueDate: string, today: string): AgingBucket {
  const days = dayNumber(today, 'today') - dayNumber(dueDate, 'dueDate');
  if (days <= 0) return 'current';
  if (days <= 15) return '1-15';
  if (days <= 30) return '16-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/**
 * The settlement state of an issued invoice, derived from its allocations (A8).
 *
 * - `total`: the invoice total; `openAmount`: what is still owed after every allocation;
 *   `credited`: the part settled by credit notes. `openAmount + credited` must not exceed
 *   `total`; the rest was paid.
 * - First match wins: `credited` when credit notes cover the whole (non-zero) total; `paid` when
 *   nothing is open; `overdue` when something is open and `today` is after `dueDate`; then
 *   `partly_paid` when some of it was paid, else `unpaid`.
 * - A mix of payment and credit note that clears the invoice is `paid`. A partial credit with no
 *   payment yet is `unpaid` (or `overdue`).
 */
export function settlementOf(input: {
  total: Dec;
  openAmount: Dec;
  dueDate: string;
  today: string;
  credited: Dec;
}): Settlement {
  const { total, openAmount, credited } = input;
  assertAmount(total, 'The total');
  assertAmount(openAmount, 'The open amount');
  assertAmount(credited, 'The credited amount');
  if (openAmount.plus(credited).gt(total)) {
    throw new RangeError('The open amount plus the credited amount is more than the total.');
  }
  const overdue = dayNumber(input.today, 'today') > dayNumber(input.dueDate, 'dueDate');

  if (total.gt(ZERO) && credited.eq(total)) return 'credited';
  if (openAmount.isZero()) return 'paid';
  if (overdue) return 'overdue';
  return total.minus(credited).minus(openAmount).gt(ZERO) ? 'partly_paid' : 'unpaid';
}

/** What is still open on one side of an allocation, in its currency and in NPR. */
export interface FxOpenSide {
  amount: Dec;
  npr: Dec;
}

export interface AllocationFx {
  /** NPR credited to AR: the amount at the invoice's rate. */
  arCredit: Dec;
  /** NPR debited from customer advances: the amount at the payment's rate. */
  advanceDebit: Dec;
  /** advanceDebit - arCredit: positive is an FX gain (credit), negative an FX loss (debit). */
  fxDiff: Dec;
}

function sideNpr(amount: Dec, rate: Dec, open: FxOpenSide | undefined, label: string): Dec {
  const plain = roundMoney(amount.times(rate));
  if (open === undefined) return plain;
  assertAmount(open.amount, `The ${label} open amount`);
  assertAmount(open.npr, `The ${label} open NPR`);
  if (amount.gt(open.amount)) {
    throw new RangeError(`The allocation is more than the ${label}'s open amount.`);
  }
  if (amount.eq(open.amount)) return open.npr;
  return Dec.min(plain, open.npr);
}

/**
 * The NPR entry for allocating `amount` (the invoice and the payment share one currency, A13)
 * from a payment at `paymentRate` to an invoice at `itemRate` (numeric(18,6) text; "1" for NPR):
 * Dr customer advances `advanceDebit` / Cr AR `arCredit`, and `fxDiff` balances it exactly.
 *
 * Each side is `amount x rate`, rounded half up. Rounding each piece of a split payment would
 * leave a paisa or two of NPR on an item once its currency amount is 0, so a side may pass what
 * is still open on it (`open.item`, `open.payment`): the allocation that clears the open amount
 * takes exactly the open NPR, and an earlier one never takes more than the open NPR. With both
 * sides passed, an invoice and a payment settled in any number of pieces both end at NPR 0.
 */
export function allocationFx(
  amount: Dec,
  itemRate: string,
  paymentRate: string,
  open?: { item?: FxOpenSide; payment?: FxOpenSide },
): AllocationFx {
  assertAmount(amount, 'The allocation');
  if (amount.isZero()) throw new RangeError('The allocation must be more than zero.');
  const arCredit = sideNpr(amount, parseFxRate(itemRate), open?.item, 'invoice');
  const advanceDebit = sideNpr(amount, parseFxRate(paymentRate), open?.payment, 'payment');
  return { arCredit, advanceDebit, fxDiff: advanceDebit.minus(arCredit) };
}
