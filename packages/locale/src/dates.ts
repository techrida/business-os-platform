// Kathmandu time, Bikram Sambat (BS) dates and the Nepali fiscal year (NFR: correct dates regardless of server TZ).
// Why the indirection: nepali-date-converter reads the *local* components of a JS Date, so passing a raw instant
// would give a different BS day on a server in UTC or New York. We first work out the calendar day in
// Asia/Kathmandu (UTC+05:45, no DST) and hand the library a Date built from those components at noon local time.
import NepaliDate from 'nepali-date-converter';

const KATHMANDU = 'Asia/Kathmandu';
const BS_RANGE_ERROR = 'BS date out of supported range 2000–2090';

const dayParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: KATHMANDU,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date (m is 1-12) in Kathmandu at the given instant. */
export function kathmanduDate(instant: Date): { y: number; m: number; d: number } {
  const parts = dayParts.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

export interface BsDate {
  year: number;
  /** 1-12 (Baisakh = 1). */
  month: number;
  day: number;
  monthNameEn: string;
  monthNameNp: string;
}

function toNepaliDate(instant: Date): NepaliDate {
  const { y, m, d } = kathmanduDate(instant);
  // setFullYear, not the Date constructor: the constructor maps years 0-99 to 1900-1999.
  // Noon keeps the local day stable across any DST shift in the server's own zone.
  const local = new Date(2000, 0, 1, 12);
  local.setFullYear(y, m - 1, d);
  try {
    return new NepaliDate(local);
  } catch {
    throw new RangeError(BS_RANGE_ERROR);
  }
}

/** The BS date for the Kathmandu calendar day of `instant`. Throws RangeError outside BS 2000-2090. */
export function toBs(instant: Date): BsDate {
  const nd = toNepaliDate(instant);
  return {
    year: nd.getYear(),
    month: nd.getMonth() + 1, // the library's months are 0-indexed
    day: nd.getDate(),
    monthNameEn: nd.format('MMMM', 'en'),
    monthNameNp: nd.format('MMMM', 'np'),
  };
}

/** Formats the BS date with the library's tokens (e.g. 'YYYY-MM-DD MMMM'). */
export function formatBs(instant: Date, fmt: string, lang: 'en' | 'np' = 'en'): string {
  return toNepaliDate(instant).format(fmt, lang);
}

/**
 * Nepali fiscal year, e.g. `2082/83`. It runs from Shrawan 1 (BS month 4) to the end of Asar (month 3 of the next BS year).
 */
export function fiscalYearOf(instant: Date): string {
  const { year, month } = toBs(instant);
  const [start, end] = month >= 4 ? [year, year + 1] : [year - 1, year];
  return `${start}/${String(end % 100).padStart(2, '0')}`;
}

/** Display in Kathmandu time, e.g. `17 Jul 2025` or `17 Jul 2025, 05:45`. */
export function formatKathmandu(instant: Date, style: 'date' | 'datetime'): string {
  const base: Intl.DateTimeFormatOptions = {
    timeZone: KATHMANDU,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  };
  const opts: Intl.DateTimeFormatOptions =
    style === 'date' ? base : { ...base, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return new Intl.DateTimeFormat('en-GB', opts).format(instant);
}

/** Default for customer-visible Gregorian calendar dates. */
export const DEFAULT_CUSTOMER_DATE_FORMAT = 'dd MMM yyyy';

const CUSTOMER_DATE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Formats a YYYY-MM-DD calendar date without a timezone conversion.
 * Legacy milestone descriptions and notification fallbacks pass through as written.
 */
export function formatCustomerDate(value: string): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!date) return value;
  const [, year, month, day] = date;
  const abbreviation = CUSTOMER_DATE_MONTHS[Number(month) - 1];
  const calendarDay = new Date(value);
  if (
    !abbreviation ||
    Number.isNaN(calendarDay.getTime()) ||
    calendarDay.toISOString().slice(0, 10) !== value
  ) {
    return value;
  }
  return DEFAULT_CUSTOMER_DATE_FORMAT.replace('dd', day!)
    .replace('MMM', abbreviation)
    .replace('yyyy', year!);
}
