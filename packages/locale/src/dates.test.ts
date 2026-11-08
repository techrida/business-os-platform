import { describe, expect, it } from 'vitest';
import { formatBs, formatKathmandu } from './dates.js';

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
