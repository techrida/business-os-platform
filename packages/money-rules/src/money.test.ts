import { describe, expect, it } from 'vitest';

import {
  Dec,
  formatMoney,
  moneyToString,
  parseDecimal,
  parseFxRate,
  parseMoney,
  parseQuantity,
  roundMoney,
} from './money.js';

describe('parseDecimal', () => {
  it.each(['0', '12', '-3', '1880000.00', '0.0001', ' 7.50 '])('accepts %j', (text) => {
    expect(parseDecimal(text).toString()).toBe(new Dec(text.trim()).toString());
  });

  it.each(['', '.5', '5.', '1e3', '1,000.00', '--1', '0x10', 'NaN', 'Infinity', '1 000'])(
    'rejects %j',
    (text) => {
      expect(() => parseDecimal(text)).toThrow(RangeError);
    },
  );

  it('refuses a JS number even when it is exact, so no caller can pass a float by mistake', () => {
    expect(() => parseDecimal(0.5 as unknown as string)).toThrow(TypeError);
  });

  it('keeps 0.1 + 0.2 exact, which a float cannot', () => {
    expect(parseDecimal('0.1').plus(parseDecimal('0.2')).toString()).toBe('0.3');
  });
});

describe('roundMoney / parseMoney (ROUND_HALF_UP to 2dp)', () => {
  it.each([
    ['1.005', '1.01'], // a float would give 1.00
    ['1.004', '1.00'],
    ['2.675', '2.68'],
    ['0.125', '0.13'],
    ['-0.005', '-0.01'],
    ['-1.004', '-1.00'],
    ['207999.9992', '208000.00'],
    ['0', '0.00'],
  ])('%s -> %s', (input, expected) => {
    expect(moneyToString(parseMoney(input))).toBe(expected);
  });

  it('is idempotent', () => {
    const once = roundMoney(new Dec('12.3456'));
    expect(roundMoney(once).toString()).toBe(once.toString());
  });

  it('never prints a negative zero', () => {
    expect(moneyToString(new Dec('-0.004'))).toBe('0.00');
  });
});

describe('parseQuantity and parseFxRate', () => {
  it('accepts numeric(18,4) quantities and rejects a fifth decimal', () => {
    expect(parseQuantity('2.5001').toString()).toBe('2.5001');
    expect(() => parseQuantity('2.50001')).toThrow(RangeError);
  });

  it('rejects zero and negative quantities', () => {
    expect(() => parseQuantity('0')).toThrow(RangeError);
    expect(() => parseQuantity('-1')).toThrow(RangeError);
  });

  it('accepts numeric(18,6) rates and rejects a seventh decimal, zero and negatives', () => {
    expect(parseFxRate('133.456789').toString()).toBe('133.456789');
    expect(() => parseFxRate('133.4567891')).toThrow(RangeError);
    expect(() => parseFxRate('0')).toThrow(RangeError);
    expect(() => parseFxRate('-1.6')).toThrow(RangeError);
  });
});

describe('formatMoney (re-exported from @bos/locale)', () => {
  it('groups NPR and INR in lakhs and crores', () => {
    expect(formatMoney('1250000', 'NPR')).toBe('NPR 12,50,000.00');
    expect(formatMoney('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(formatMoney('123456789.5', 'INR')).toBe('INR 12,34,56,789.50');
  });

  it('groups USD in the western way', () => {
    expect(formatMoney('1250000', 'USD')).toBe('USD 1,250,000.00');
  });
});
