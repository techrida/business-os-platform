import { describe, expect, it } from 'vitest';

import {
  formatInstant,
  kathmanduLocalToIso,
  todayInKathmandu,
  trimRate,
  withoutTrailingZeros,
} from './format';

describe('kathmanduLocalToIso', () => {
  it('adds the Nepal offset and the result is the right instant', () => {
    const iso = kathmanduLocalToIso('2026-11-08T09:30');
    expect(iso).toBe('2026-11-08T09:30:00+05:45');
    expect(new Date(iso ?? '').toISOString()).toBe('2026-11-08T03:45:00.000Z');
  });

  it('refuses anything that is not a datetime-local value', () => {
    expect(kathmanduLocalToIso('')).toBeNull();
    expect(kathmanduLocalToIso('2026-11-08')).toBeNull();
    expect(kathmanduLocalToIso('2026-13-45T25:61')).toBeNull();
  });
});

describe('formatInstant', () => {
  it('shows Kathmandu time, which can already be the next day', () => {
    expect(formatInstant('2025-07-16T18:15:00.000Z')).toContain('17 Jul 2025');
  });

  it('returns the raw text for a value that is not a date', () => {
    expect(formatInstant('not a date')).toBe('not a date');
  });
});

describe('todayInKathmandu', () => {
  it('uses the Kathmandu calendar day, not the UTC one', () => {
    expect(todayInKathmandu(new Date('2025-07-16T18:30:00Z'))).toBe('2025-07-17');
    expect(todayInKathmandu(new Date('2025-07-16T18:00:00Z'))).toBe('2025-07-16');
  });
});

describe('trimRate', () => {
  it('drops trailing zeros but keeps two decimals', () => {
    expect(trimRate('133.500000')).toBe('133.50');
    expect(trimRate('1.612345')).toBe('1.612345');
    expect(trimRate('2')).toBe('2.00');
    expect(trimRate('n/a')).toBe('n/a');
  });
});

describe('withoutTrailingZeros', () => {
  it.each([
    ['100000.000', 2, '100000'],
    ['13.0000', 2, '13'],
    ['12.5000', 2, '12.5'],
    ['1.0050', 2, '1.005'],
  ])('reads the stored %s in a %i-decimal field as %s', (stored, scale, shown) => {
    expect(withoutTrailingZeros(stored, scale)).toBe(shown);
  });

  it.each(['100000', '100000.00', '250000.50', '100.05', '', 'abc', '1,000.000', '1e3'])(
    'leaves %j as it is in a 2-decimal field',
    (value) => {
      expect(withoutTrailingZeros(value, 2)).toBe(value);
    },
  );

  it('leaves 25.0000 in a 4-decimal field', () => {
    expect(withoutTrailingZeros('25.0000', 4)).toBe('25.0000');
  });
});
