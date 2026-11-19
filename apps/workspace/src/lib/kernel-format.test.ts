import { describe, expect, it } from 'vitest';

import { money, snapshotEntries } from './kernel-format';

describe('money() number system', () => {
  it('keeps each currency its own grouping when no number system is given', () => {
    expect(money('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD')).toBe('USD 2,018,180.00');
    expect(money('2018180')).toBe('NPR 20,18,180.00');
  });

  it('applies the tenant number system to every currency when one is given', () => {
    expect(money('2018180', 'NPR', 'international')).toBe('NPR 2,018,180.00');
    expect(money('2018180', 'USD', 'international')).toBe('USD 2,018,180.00');
    expect(money('2018180', 'NPR', 'south_asian')).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD', 'south_asian')).toBe('USD 20,18,180.00');
  });

  it('still returns odd text untouched', () => {
    expect(money('abc', 'NPR', 'international')).toBe('abc');
  });

  it('groups snapshot amounts by the number system', () => {
    const snapshot = { currency: 'NPR', amount: '2018180', totalNpr: '2018180.00' };
    const values = (ns?: 'international') =>
      snapshotEntries(snapshot, undefined, ns).map((row) => row.value);
    expect(values('international')).toEqual(['NPR', 'NPR 2,018,180.00', 'NPR 2,018,180.00']);
    expect(values()).toEqual(['NPR', 'NPR 20,18,180.00', 'NPR 20,18,180.00']);
  });
});
