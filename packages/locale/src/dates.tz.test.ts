// Inner file of dates.matrix.test.ts: it only runs when that parent re-launches vitest with TZ set.
import { describe, expect, it } from 'vitest';
import { fiscalYearOf, kathmanduDate, kathmanduDateString, toBs } from './dates.js';

describe.skipIf(!process.env['LOCALE_TZ_RUN'])(
  `BS dates and fiscal year under TZ=${process.env['TZ']}`,
  () => {
    it('really runs in the requested zone (otherwise every run would silently be UTC)', () => {
      const offset = new Date(2025, 0, 1).getTimezoneOffset();
      expect([0, -345, 300]).toContain(offset);
      const expected = { UTC: 0, 'Asia/Kathmandu': -345, 'America/New_York': 300 }[
        process.env['TZ'] ?? ''
      ];
      expect(offset).toBe(expected);
    });

    it.each([
      ['2025-04-14T06:00:00Z', 2082, 1, 1],
      ['2024-04-13T06:00:00Z', 2081, 1, 1],
      ['2025-07-17T06:00:00Z', 2082, 4, 1],
      ['2025-07-16T06:00:00Z', 2082, 3, 32],
    ])('%s is BS %i-%i-%i', (iso, year, month, day) => {
      expect(toBs(new Date(iso))).toMatchObject({ year, month, day });
    });

    it('names the months', () => {
      expect(toBs(new Date('2025-04-14T06:00:00Z'))).toMatchObject({ monthNameEn: 'Baisakh' });
      expect(toBs(new Date('2025-07-17T06:00:00Z')).monthNameNp).toBeTruthy();
    });

    it('flips the Kathmandu day at 18:15 UTC (the midnight case)', () => {
      const after = new Date('2025-07-16T18:15:00Z');
      const before = new Date('2025-07-16T18:14:59Z');
      expect(kathmanduDate(after)).toEqual({ y: 2025, m: 7, d: 17 });
      expect(kathmanduDate(before)).toEqual({ y: 2025, m: 7, d: 16 });
      expect(toBs(after)).toMatchObject({ year: 2082, month: 4, day: 1 });
      expect(toBs(before)).toMatchObject({ year: 2082, month: 3, day: 32 });
      expect(fiscalYearOf(after)).toBe('2082/83');
      expect(fiscalYearOf(before)).toBe('2081/82');
    });

    it('formats the Kathmandu day as YYYY-MM-DD, flipping at 18:15 UTC', () => {
      expect(kathmanduDateString(new Date('2026-11-19T18:14:59Z'))).toBe('2026-11-19');
      expect(kathmanduDateString(new Date('2026-11-19T18:15:00Z'))).toBe('2026-11-20');
      expect(kathmanduDateString(new Date('2026-11-19T20:30:00Z'))).toBe('2026-11-20');
      expect(kathmanduDateString(new Date('2026-12-31T18:15:00Z'))).toBe('2027-01-01');
    });

    it('computes the fiscal year across the BS year boundary', () => {
      expect(fiscalYearOf(new Date('2025-07-17T06:00:00Z'))).toBe('2082/83');
      expect(fiscalYearOf(new Date('2025-07-16T06:00:00Z'))).toBe('2081/82');
      expect(fiscalYearOf(new Date('2025-04-14T06:00:00Z'))).toBe('2081/82'); // Baisakh 1, still FY 2081/82
      expect(fiscalYearOf(new Date('2026-04-01T06:00:00Z'))).toBe('2082/83');
    });

    it('pads the short year to 2 digits', () => {
      // Shrawan 2000 is the first one in range: FY 2000/01 needs the leading zero.
      expect(fiscalYearOf(new Date('1943-08-01T06:00:00Z'))).toBe('2000/01');
    });

    it('throws RangeError outside BS 2000-2090', () => {
      expect(() => toBs(new Date('1900-01-01T00:00:00Z'))).toThrow(RangeError);
      expect(() => toBs(new Date('1900-01-01T00:00:00Z'))).toThrow(
        'BS date out of supported range 2000–2090',
      );
      expect(() => toBs(new Date('2030-01-01T00:00:00Z'))).not.toThrow();
      expect(() => toBs(new Date('2200-01-01T00:00:00Z'))).toThrow(RangeError);
      expect(() => fiscalYearOf(new Date('2200-01-01T00:00:00Z'))).toThrow(RangeError);
    });
  },
);
