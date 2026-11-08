// Small date helpers for the admin screens. Everything the admin sees and types is Nepal time
// (Asia/Kathmandu, UTC+05:45, no daylight saving), whatever the server's own zone is.
import { formatKathmandu } from '@bos/locale';

const KATHMANDU_OFFSET = '+05:45';

/** An ISO instant as "17 Jul 2025, 00:00" in Kathmandu time; the raw text if it is not a date. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatKathmandu(date, 'datetime');
}

/**
 * A `datetime-local` value ("2026-11-08T09:30") has no zone, and the API rejects an ISO string
 * without an offset. The server's own zone is not Nepal's, so the offset is written explicitly.
 */
export function kathmanduLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const iso = `${local}:00${KATHMANDU_OFFSET}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** Today's calendar date in Kathmandu as YYYY-MM-DD (the `en-CA` locale prints it in that order). */
export function todayInKathmandu(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(now);
}

/** "133.500000" as "133.50": rates are stored with 6 decimals, but trailing zeros only add noise. */
export function trimRate(rate: string): string {
  if (!/^\d+(\.\d+)?$/.test(rate)) return rate;
  const [whole = '', fraction = ''] = rate.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}
