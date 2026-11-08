// Largest-remainder allocation: split an amount over weights so the parts add up exactly.
import { Dec } from './money.js';

const ZERO = new Dec(0);

function toScaledInteger(value: Dec, scale: number): bigint {
  return BigInt(value.times(new Dec(10).pow(scale)).toFixed(0));
}

/**
 * Splits `total` (a non-negative amount with at most 2 decimals) over `weights`
 * (non-negative, any decimals) in proportion to the weights. Every part is a whole paisa and the
 * parts sum to `total` exactly.
 *
 * Method: floor each exact share to the paisa, then give the leftover paisa one at a time to the
 * lines with the largest fractional remainders. Equal remainders go to the lower index. The
 * arithmetic runs on BigInt, so remainders are compared exactly, not through a rounded quotient.
 * A zero-weight line is never given a paisa.
 */
export function allocateLargestRemainder(total: Dec, weights: readonly Dec[]): Dec[] {
  if (total.isNegative()) throw new RangeError('Cannot allocate a negative amount.');
  if (total.decimalPlaces() > 2)
    throw new RangeError('The amount to allocate has more than 2 decimals.');
  if (weights.some((w) => w.isNegative()))
    throw new RangeError('Allocation weights must not be negative.');

  const totalPaisa = toScaledInteger(total, 2);
  if (weights.length === 0 || weights.every((w) => w.isZero())) {
    if (totalPaisa !== 0n)
      throw new RangeError('A positive amount needs at least one positive weight.');
    return weights.map(() => ZERO);
  }

  const scale = weights.reduce((max, w) => Math.max(max, w.decimalPlaces()), 0);
  const scaled = weights.map((w) => toScaledInteger(w, scale));
  const weightSum = scaled.reduce((a, b) => a + b, 0n);

  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  for (const weight of scaled) {
    const numerator = totalPaisa * weight;
    floors.push(numerator / weightSum);
    remainders.push(numerator % weightSum);
  }

  const leftover = Number(totalPaisa - floors.reduce((a, b) => a + b, 0n));
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order.slice(0, leftover)) floors[index] = (floors[index] ?? 0n) + 1n;

  return floors.map((paisa) => new Dec(paisa.toString()).div(100));
}
