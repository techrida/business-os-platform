import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import { describe, expect, it } from 'vitest';

import { money, snapshotEntries } from './kernel-format';

const INTL: NumberSystems = { NPR: 'international', INR: 'international', USD: 'international' };
const SA: NumberSystems = { NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' };

describe('money() number system', () => {
  it('keeps each currency its own grouping when no number system is given', () => {
    expect(money('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD')).toBe('USD 2,018,180.00');
    expect(money('2018180')).toBe('NPR 20,18,180.00');
  });

  it('applies the tenant number systems when given', () => {
    expect(money('2018180', 'NPR', INTL)).toBe('NPR 2,018,180.00');
    expect(money('2018180', 'USD', INTL)).toBe('USD 2,018,180.00');
    expect(money('2018180', 'NPR', SA)).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD', SA)).toBe('USD 20,18,180.00');
    expect(money('2018180', 'USD', DEFAULT_NUMBER_SYSTEMS)).toBe('USD 2,018,180.00');
  });

  it('still returns odd text untouched', () => {
    expect(money('abc', 'NPR', INTL)).toBe('abc');
  });

  it('groups snapshot amounts by the number system', () => {
    const snapshot = { currency: 'NPR', amount: '2018180', totalNpr: '2018180.00' };
    const values = (ns?: NumberSystems) =>
      snapshotEntries(snapshot, undefined, ns).map((row) => row.value);
    expect(values(INTL)).toEqual(['NPR', 'NPR 2,018,180.00', 'NPR 2,018,180.00']);
    expect(values()).toEqual(['NPR', 'NPR 20,18,180.00', 'NPR 20,18,180.00']);
  });
});

describe('snapshotEntries terms wording', () => {
  it('shows rich terms as plain words, never markup, and leaves the stored value alone', () => {
    const snapshot = {
      scope: '<p>Includes:</p><ul><li>Survey</li><li>Install</li></ul><script>alert(1)</script>',
      termsAndConditions: 'Net 30 days',
    };
    const rows = snapshotEntries(snapshot);
    const scope = rows.find((row) => row.key === 'scope');
    expect(scope?.value).toContain('Survey');
    expect(scope?.value).toContain('Install');
    expect(scope?.value).not.toMatch(/<\/?(p|ul|li|script)/);
    expect(scope?.value).not.toContain('alert(1)');
    expect(scope?.block).toBe(true);
    expect(rows.find((row) => row.key === 'termsAndConditions')?.value).toBe('Net 30 days');
    expect(snapshot.scope).toContain('<ul>');
  });

  it('omits terms wording that has no words', () => {
    expect(snapshotEntries({ terms: '<p></p>', note: 'x' }).map((row) => row.key)).toEqual([
      'note',
    ]);
  });
});
