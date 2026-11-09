import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bandFor, DEFAULT_BAND_THRESHOLDS } from './bands.js';
import { amountNpr } from './fx.js';
import { Dec } from './money.js';

const d = (text: string) => new Dec(text);
const thresholds = { managementNpr: '100000', founderNpr: '1000000' };

describe('bandFor (AD4, strict ">")', () => {
  it('uses the AD4 defaults', () => {
    expect(DEFAULT_BAND_THRESHOLDS).toEqual(thresholds);
  });

  it('does not escalate an amount on a band edge', () => {
    expect(bandFor(d('100000.00'), thresholds)).toBe('none');
    expect(bandFor(d('1000000.00'), thresholds)).toBe('management');
  });

  it('escalates one paisa above each edge', () => {
    expect(bandFor(d('100000.01'), thresholds)).toBe('management');
    expect(bandFor(d('1000000.01'), thresholds)).toBe('founder');
  });

  it('handles zero and large amounts', () => {
    expect(bandFor(d('0'), thresholds)).toBe('none');
    expect(bandFor(d('999999999999.99'), thresholds)).toBe('founder');
  });

  it('works on the amountNpr of a foreign-currency total (the AD3 basis)', () => {
    const edge = amountNpr({ total: d('1000.00'), currency: 'USD', fxRate: '100' });
    expect(edge.toFixed(2)).toBe('100000.00');
    expect(bandFor(edge, thresholds)).toBe('none');
    const over = amountNpr({ total: d('1000.01'), currency: 'USD', fxRate: '100' });
    expect(bandFor(over, thresholds)).toBe('management');
  });

  it('reads the thresholds it is given', () => {
    expect(bandFor(d('50.01'), { managementNpr: '50', founderNpr: '500' })).toBe('management');
    expect(bandFor(d('500.01'), { managementNpr: '50', founderNpr: '500' })).toBe('founder');
  });

  it('refuses thresholds that are not plain decimals or are out of order', () => {
    expect(() => bandFor(d('1'), { managementNpr: '1e5', founderNpr: '1000000' })).toThrow(
      RangeError,
    );
    expect(() => bandFor(d('1'), { managementNpr: '200', founderNpr: '100' })).toThrow(RangeError);
  });
});

describe('bandFor properties', () => {
  const paisa = fc.integer({ min: 0, max: 500_000_000 });
  const toMoney = (p: number) => d(String(p)).div(100);
  const rank = { none: 0, management: 1, founder: 2 } as const;
  const oracle = (p: number) =>
    p > 100_000_000 ? 'founder' : p > 10_000_000 ? 'management' : 'none';

  it('matches the strict-greater oracle in paisa and never decreases with the amount', () => {
    fc.assert(
      fc.property(paisa, paisa, (a, b) => {
        expect(bandFor(toMoney(a), thresholds)).toBe(oracle(a));
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(rank[bandFor(toMoney(lo), thresholds)]).toBeLessThanOrEqual(
          rank[bandFor(toMoney(hi), thresholds)],
        );
      }),
      { numRuns: 2000 },
    );
  });
});
