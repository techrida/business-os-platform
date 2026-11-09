import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Dec, moneyToString } from './money.js';
import { payableTotal, tdsFor } from './withholding.js';

const d = (text: string) => new Dec(text);

describe('tdsFor (ROUND_HALF_UP to 2dp on net excluding VAT)', () => {
  it('computes 150 bp of 100,000.00 as 1,500.00', () => {
    expect(moneyToString(tdsFor(d('100000.00'), 150))).toBe('1500.00');
  });

  it('rounds a tie up: 0.005 -> 0.01, and 1.005 -> 1.01', () => {
    expect(tdsFor(d('0.50'), 100).toFixed(2)).toBe('0.01'); // 0.005
    expect(tdsFor(d('100.50'), 100).toFixed(2)).toBe('1.01'); // 1.005
    expect(tdsFor(d('100.49'), 100).toFixed(2)).toBe('1.00'); // 1.0049
  });

  it('is zero at a zero rate (the codes ship at zero until the accountant signs)', () => {
    expect(tdsFor(d('123456.78'), 0).toFixed(2)).toBe('0.00');
  });

  it('accepts a decimal string for the net', () => {
    expect(tdsFor('100000.00', 150).toFixed(2)).toBe('1500.00');
  });

  it('rejects a rate that is not an integer between 0 and 10,000 basis points', () => {
    expect(() => tdsFor(d('1.00'), -1)).toThrow(RangeError);
    expect(() => tdsFor(d('1.00'), 10001)).toThrow(RangeError);
    expect(() => tdsFor(d('1.00'), 1.5)).toThrow(RangeError);
    expect(() => tdsFor(d('1.00'), Number.NaN)).toThrow(RangeError);
  });
});

describe('payableTotal = net + vat - tds', () => {
  it('pays 111,500.00 for 100,000 net + 13,000 VAT - 1,500 TDS (150 bp)', () => {
    const net = d('100000.00');
    const total = payableTotal({ net, vat: d('13000.00'), tds: tdsFor(net, 150) });
    expect(moneyToString(total)).toBe('111500.00');
  });

  it('accepts decimal strings', () => {
    expect(payableTotal({ net: '10.00', vat: '1.30', tds: '0.15' }).toFixed(2)).toBe('11.15');
  });
});

describe('withholding properties', () => {
  const paisa = (value: Dec): bigint => BigInt(value.times(100).toFixed(0));
  const money = fc.bigInt({ min: 0n, max: 10n ** 13n }).map((p) => new Dec(p.toString()).div(100));

  it('TDS equals the half-up share in integer paisa and never exceeds the net', () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 0, max: 10_000 }), (net, rateBp) => {
        const tds = tdsFor(net, rateBp);
        // Oracle in integer paisa: round_half_up(netPaisa * rateBp / 10_000).
        const expected = (paisa(net) * BigInt(rateBp) + 5_000n) / 10_000n;
        expect(paisa(tds)).toBe(expected);
        expect(tds.lte(net)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('payable adds up to net + vat - tds to the paisa', () => {
    fc.assert(
      fc.property(money, money, fc.integer({ min: 0, max: 10_000 }), (net, vat, rateBp) => {
        const tds = tdsFor(net, rateBp);
        const total = payableTotal({ net, vat, tds });
        expect(paisa(total)).toBe(paisa(net) + paisa(vat) - paisa(tds));
      }),
      { numRuns: 2000 },
    );
  });
});
