import { describe, expect, it } from 'vitest';
import { CUSTOMER_DATE_FORMATS, formatBs, formatCustomerDate, formatKathmandu } from './dates.js';

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
