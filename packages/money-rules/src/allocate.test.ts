import { describe, expect, it } from 'vitest';

import { allocateLargestRemainder } from './allocate.js';
import { Dec, moneyToString } from './money.js';

const run = (total: string, weights: string[]): string[] =>
  allocateLargestRemainder(
    new Dec(total),
    weights.map((w) => new Dec(w)),
  ).map(moneyToString);

describe('allocateLargestRemainder', () => {
  it('reproduces the P2 architect worked example (leftover paisa goes to line 3)', () => {
    // Raw shares 144000.000554 / 56000.000215 / 7999.999231 of 208,000.00.
    expect(run('208000.00', ['1800000.00', '700000.00', '99999.99'])).toEqual([
      '144000.00',
      '56000.00',
      '8000.00',
    ]);
  });

  it('hands the leftover paisa out one by one, largest remainder first', () => {
    // 1.00 over three equal weights: 0.33 each, one spare paisa.
    expect(run('1.00', ['1', '1', '1'])).toEqual(['0.34', '0.33', '0.33']);
    // Shares 0.4 / 0.4 / 0.2 paisa of a 1 paisa total: the 0.4s are bigger remainders than 0.2.
    expect(run('0.01', ['2', '2', '1'])).toEqual(['0.01', '0.00', '0.00']);
    expect(run('0.01', ['1', '2', '2'])).toEqual(['0.00', '0.01', '0.00']);
  });

  it('breaks exact ties in favour of the lower index, never the higher', () => {
    expect(run('0.02', ['1', '1', '1', '1'])).toEqual(['0.01', '0.01', '0.00', '0.00']);
  });

  it('gives nothing to a zero-weight line', () => {
    expect(run('0.10', ['0', '3', '0', '3'])).toEqual(['0.00', '0.05', '0.00', '0.05']);
    expect(run('0.01', ['0', '1', '1'])).toEqual(['0.00', '0.01', '0.00']);
  });

  it('allocates a zero total as all zeros, even over zero weights', () => {
    expect(run('0.00', ['5', '7'])).toEqual(['0.00', '0.00']);
    expect(run('0', ['0', '0'])).toEqual(['0.00', '0.00']);
    expect(run('0', [])).toEqual([]);
  });

  it('returns the whole total for a single line', () => {
    expect(run('94000.00', ['1880000.00'])).toEqual(['94000.00']);
  });

  it('keeps exact sums on amounts above 2^53 paisa', () => {
    const total = '99999999999999.99';
    const parts = allocateLargestRemainder(new Dec(total), [
      new Dec('1'),
      new Dec('1'),
      new Dec('1'),
    ]);
    expect(parts.reduce((a, b) => a.plus(b), new Dec(0)).toFixed(2)).toBe(total);
  });

  it('accepts weights with decimals (line net has 2dp, quantities may be finer)', () => {
    expect(run('10.00', ['0.5', '0.25', '0.25'])).toEqual(['5.00', '2.50', '2.50']);
  });

  it('rejects a positive total with no weight to carry it', () => {
    expect(() => run('0.01', ['0', '0'])).toThrow(RangeError);
    expect(() => run('1.00', [])).toThrow(RangeError);
  });

  it('rejects a total with more than 2 decimals, or a negative total or weight', () => {
    expect(() => run('1.005', ['1'])).toThrow(RangeError);
    expect(() => run('-1.00', ['1'])).toThrow(RangeError);
    expect(() => run('1.00', ['-1', '2'])).toThrow(RangeError);
  });
});
