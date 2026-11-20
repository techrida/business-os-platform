import { describe, expect, it } from 'vitest';
import {
  BS_MONTH_NAMES_EN,
  bsLongOfDay,
  CUSTOMER_DATE_FORMATS,
  formatBs,
  formatBsLong,
  formatCustomerDate,
  formatKathmandu,
  toBs,
} from './dates.js';

describe('formatKathmandu', () => {
  it('shows date and time in UTC+05:45', () => {
    const i = new Date('2025-07-16T23:59:00Z'); // 05:44 next day in Kathmandu
    expect(formatKathmandu(new Date('2025-07-16T23:30:00Z'), 'datetime')).toBe(
      '17 Jul 2025, 05:15',
    );
    expect(formatKathmandu(i, 'datetime')).toBe('17 Jul 2025, 05:44');
    expect(formatKathmandu(i, 'date')).toBe('17 Jul 2025');
  });

  it('uses a 24-hour clock without a 24:00 at midnight', () => {
    expect(formatKathmandu(new Date('2025-07-16T18:15:00Z'), 'datetime')).toBe(
      '17 Jul 2025, 00:00',
    );
  });
});

describe('formatBs', () => {
  it('passes the format and language to the library', () => {
    const i = new Date('2025-07-17T06:00:00Z');
    expect(formatBs(i, 'YYYY-MM-DD MMMM')).toBe('2082-04-01 Shrawan');
    expect(formatBs(i, 'YYYY-MM-DD', 'np')).toMatch(/^[०-९]{4}-[०-९]{2}-[०-९]{2}$/);
  });

  it('throws RangeError outside the supported range', () => {
    expect(() => formatBs(new Date('1900-01-01T00:00:00Z'), 'YYYY')).toThrow(RangeError);
  });
});

describe('formatBsLong', () => {
  it('writes the stored compact BS date as day, month name, year and BS', () => {
    expect(formatBsLong('2083-09-04')).toBe('04 Poush 2083 BS');
    expect(formatBsLong('2082-04-01')).toBe('01 Shrawan 2082 BS');
  });

  /** A Gregorian day inside each BS month of 2083, Baisakh first. */
  const DAY_IN_MONTH = [
    '2026-04-20',
    '2026-05-20',
    '2026-06-20',
    '2026-07-25',
    '2026-08-25',
    '2026-09-25',
    '2026-10-25',
    '2026-11-25',
    '2026-12-25',
    '2027-01-25',
    '2027-02-20',
    '2027-03-25',
  ];

  it.each(BS_MONTH_NAMES_EN.map((name, i) => [i + 1, name] as const))(
    'names BS month %i as the converter does (%s)',
    (month, name) => {
      expect(formatBsLong(`2083-${String(month).padStart(2, '0')}-15`)).toBe(`15 ${name} 2083 BS`);
      // The converter's own name for a day in that month: the list and the library never drift apart.
      const bs = toBs(new Date(`${DAY_IN_MONTH[month - 1]}T12:00:00+05:45`));
      expect([bs.month, bs.monthNameEn]).toEqual([month, name]);
    },
  );

  it('never throws: text that is not a compact BS date keeps its old form', () => {
    expect(formatBsLong('2083-13-01')).toBe('2083-13-01 BS');
    expect(formatBsLong('2083-00-01')).toBe('2083-00-01 BS');
    expect(formatBsLong('soon')).toBe('soon BS');
  });
});

describe('bsLongOfDay', () => {
  it('converts a Gregorian day at noon in Kathmandu', () => {
    expect(bsLongOfDay('2025-07-17')).toBe('01 Shrawan 2082 BS');
  });

  it('prints a converted day exactly as the frozen issue date prints', () => {
    const instant = new Date('2026-12-20T03:00:00Z');
    expect(bsLongOfDay('2026-12-20')).toBe(formatBsLong(formatBs(instant, 'YYYY-MM-DD')));
  });

  it('is null outside the converter range and for text that is not a date', () => {
    expect(bsLongOfDay('1900-01-01')).toBeNull();
    expect(bsLongOfDay('On receipt')).toBeNull();
  });
});

describe('formatCustomerDate', () => {
  it.each([
    ['2026-11-19', '19 Nov 2026'],
    ['2026-09-01', '01 Sep 2026'],
    ['2028-02-29', '29 Feb 2028'],
    ['2026-02-29', '2026-02-29'],
    ['On order', 'On order'],
  ])('formats %s as %s', (date, expected) => {
    expect(formatCustomerDate(date)).toBe(expected);
  });
});

describe('formatCustomerDate formats (D27)', () => {
  it('prints the chosen pattern, default dd MMM yyyy', () => {
    expect(formatCustomerDate('2026-11-19')).toBe('19 Nov 2026');
    expect(formatCustomerDate('2026-11-19', 'dd/MM/yyyy')).toBe('19/11/2026');
    expect(formatCustomerDate('2026-11-19', 'yyyy-MM-dd')).toBe('2026-11-19');
    expect(formatCustomerDate('2026-11-19', 'MMM dd, yyyy')).toBe('Nov 19, 2026');
  });

  it('passes through non-dates and impossible dates in every format', () => {
    for (const f of CUSTOMER_DATE_FORMATS) {
      expect(formatCustomerDate('Net 15', f)).toBe('Net 15');
      expect(formatCustomerDate('2026-02-30', f)).toBe('2026-02-30');
    }
  });
});
