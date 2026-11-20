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

/** The calendar date in Kathmandu at the given instant, as YYYY-MM-DD (the business "today" for date rules). */
export function kathmanduDateString(instant: Date): string {
  const { y, m, d } = kathmanduDate(instant);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
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

/** BS month names as the converter spells them in English, Baisakh (month 1) first. */
export const BS_MONTH_NAMES_EN = [
  'Baisakh',
  'Jestha',
  'Asar',
  'Shrawan',
  'Bhadra',
  'Aswin',
  'Kartik',
  'Mangsir',
  'Poush',
  'Magh',
  'Falgun',
  'Chaitra',
] as const;

const BS_COMPACT = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The one BS date form for documents and pages (U16-Q5): `04 Poush 2083 BS`. Takes a stored compact BS date
 * (`2083-09-04`, as `issue_date_bs` keeps it). Never throws: text that is not a compact BS date comes back with
 * ` BS` after it, so a render always has something to show. The compact form is for table cells only.
 */
export function formatBsLong(compactBs: string): string {
  const match = BS_COMPACT.exec(compactBs);
  const month = match ? BS_MONTH_NAMES_EN[Number(match[2]) - 1] : undefined;
  if (!match || month === undefined || Number(match[3]) < 1 || Number(match[3]) > 32) {
    return `${compactBs} BS`;
  }
  return `${match[3]} ${month} ${match[1]} BS`;
}

/**
 * The long BS form (`04 Poush 2083 BS`) of a Gregorian calendar day `YYYY-MM-DD`, read at noon in Kathmandu so no
 * timezone moves the day. Null when the text is not a date or the day is outside the converter's range.
 */
export function bsLongOfDay(isoDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const instant = new Date(`${isoDate}T12:00:00+05:45`);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return formatBsLong(formatBs(instant, 'YYYY-MM-DD'));
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
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

/** The date patterns a company may choose for customer-facing documents (D27 default first). */
export const CUSTOMER_DATE_FORMATS = [
  'dd MMM yyyy',
  'dd/MM/yyyy',
  'yyyy-MM-dd',
  'MMM dd, yyyy',
] as const;
export type CustomerDateFormat = (typeof CUSTOMER_DATE_FORMATS)[number];

/** Default for customer-visible Gregorian calendar dates. */
export const DEFAULT_CUSTOMER_DATE_FORMAT: CustomerDateFormat = 'dd MMM yyyy';

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
 * Formats a YYYY-MM-DD calendar date without a timezone conversion, in the company's chosen pattern.
 * Legacy milestone descriptions and notification fallbacks pass through as written.
 */
export function formatCustomerDate(
  value: string,
  format: CustomerDateFormat = DEFAULT_CUSTOMER_DATE_FORMAT,
): string {
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
  switch (format) {
    case 'dd/MM/yyyy':
      return `${day}/${month}/${year}`;
    case 'yyyy-MM-dd':
      return `${year}-${month}-${day}`;
    case 'MMM dd, yyyy':
      return `${abbreviation} ${day}, ${year}`;
    case 'dd MMM yyyy':
      return `${day} ${abbreviation} ${year}`;
  }
}
