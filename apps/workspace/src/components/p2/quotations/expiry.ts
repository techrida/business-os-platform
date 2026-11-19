import { kathmanduDate } from '@bos/locale';

export type ExpiryState = 'valid' | 'expiring' | 'expired';

export interface Expiry {
  state: ExpiryState;
  /** Whole calendar days from `today` to `validUntil`: positive before, 0 on the day, negative after. */
  daysLeft: number;
  /** "Expires in 5 days", "Expires today" or "Expired 3 days ago". */
  label: string;
}

/** A quotation counts as expiring in its last week. */
export const EXPIRING_WITHIN_DAYS = 7;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isIsoCalendarDate(value: string): boolean {
  return epochDay(value) !== null;
}

/** Days since the epoch for a real YYYY-MM-DD date, or null. No time zone is involved. */
function epochDay(value: string): number | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const date = new Date(ms);
  return date.toISOString().slice(0, 10) === value ? ms / DAY_MS : null;
}

/** Today's calendar date in Asia/Kathmandu as YYYY-MM-DD. */
export function kathmanduToday(now: Date = new Date()): string {
  const { y, m, d } = kathmanduDate(now);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * Where a quotation's validity stands. Both arguments are calendar dates (YYYY-MM-DD, Kathmandu);
 * `today` is passed in so the answer never depends on a clock or the server's time zone. A
 * malformed date throws: the contract guarantees the format, so a bad one is a bug to surface.
 */
export function expiryState(validUntil: string, today: string): Expiry {
  const until = epochDay(validUntil);
  const now = epochDay(today);
  if (until === null) throw new RangeError(`Not a calendar date: ${validUntil}`);
  if (now === null) throw new RangeError(`Not a calendar date: ${today}`);
  const daysLeft = until - now;
  if (daysLeft < 0) {
    return { state: 'expired', daysLeft, label: `Expired ${days(-daysLeft)} ago` };
  }
  if (daysLeft === 0) return { state: 'expiring', daysLeft, label: 'Expires today' };
  return {
    state: daysLeft <= EXPIRING_WITHIN_DAYS ? 'expiring' : 'valid',
    daysLeft,
    label: `Expires in ${days(daysLeft)}`,
  };
}
