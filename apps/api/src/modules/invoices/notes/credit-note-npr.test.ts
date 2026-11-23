// creditNoteNpr: the NPR of a partial credit note on a foreign-currency invoice (R6G, decision D1 option A).
// Run: pnpm --filter @bos/api exec vitest run src/modules/invoices/notes/credit-note-npr.test.ts
import { Dec, toNpr } from '@bos/money-rules';
import { describe, expect, it } from 'vitest';

import { creditNoteNpr } from './credit-note-npr';

/** The rule before R6G: each partial credit converted on its own; only a credit that credits every line took the rest. */
function oldSteps(total: string, rate: string, credits: string[]): string[] {
  const originalNpr = toNpr(new Dec(total), 'INR', rate);
  let nprBefore = new Dec(0);
  let creditedBefore = new Dec(0);
  return credits.map((c) => {
    creditedBefore = creditedBefore.plus(c);
    const step = creditedBefore.gte(total)
      ? originalNpr.minus(nprBefore)
      : toNpr(new Dec(c), 'INR', rate);
    nprBefore = nprBefore.plus(step);
    return step.toFixed(2);
  });
}

/** The notes issued in `credits` order, each priced by creditNoteNpr against the ones issued before it. */
function newSteps(total: string, rate: string, credits: string[]): string[] {
  const originalNpr = toNpr(new Dec(total), 'INR', rate);
  let nprBefore = new Dec(0);
  let creditedBefore = new Dec(0);
  return credits.map((c) => {
    const step = creditNoteNpr({
      originalTotal: new Dec(total),
      originalNpr,
      creditedBefore,
      creditedNprBefore: nprBefore,
      noteTotal: new Dec(c),
    });
    creditedBefore = creditedBefore.plus(c);
    nprBefore = nprBefore.plus(step);
    return step.toFixed(2);
  });
}

describe('creditNoteNpr: the repro amounts', () => {
  it('0.06 INR at 1.6 in five 0.01 steps and a closing 0.01: the old rule closes on 0.00, the new one on 0.02', () => {
    const credits = ['0.01', '0.01', '0.01', '0.01', '0.01', '0.01'];
    expect(oldSteps('0.06', '1.6', credits)).toEqual([
      '0.02',
      '0.02',
      '0.02',
      '0.02',
      '0.02',
      '0.00',
    ]);
    const steps = newSteps('0.06', '1.6', credits);
    expect(steps).toEqual(['0.02', '0.01', '0.02', '0.02', '0.01', '0.02']);
    expect(steps.reduce((a, s) => a.plus(s), new Dec(0)).toFixed(2)).toBe('0.10');
  });

  it('0.07 INR at 1.6 with six credits: the old rule closes on -0.01, the new one on a positive cent', () => {
    const credits = ['0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '0.01'];
    expect(oldSteps('0.07', '1.6', credits).some((s) => s.startsWith('-'))).toBe(true);
    const steps = newSteps('0.07', '1.6', credits);
    expect(steps.every((s) => new Dec(s).gt(0))).toBe(true);
    expect(steps.reduce((a, s) => a.plus(s), new Dec(0)).toFixed(2)).toBe('0.11');
  });

  it('one credit of the whole total takes the whole NPR value', () => {
    expect(newSteps('0.07', '1.6', ['0.07'])).toEqual(['0.11']);
  });
});

describe('creditNoteNpr: property loop', () => {
  // Deterministic generator (mulberry32) so a failure reproduces.
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  it('every random split: each step is positive, the steps add to the original NPR, and each running sum is the rounded share', () => {
    for (let n = 0; n < 3000; n++) {
      const totalCents = int(1, n % 10 === 0 ? 20_000_000 : 400);
      // INR and USD rates are at least 1 (CURRENCIES = NPR, INR, USD).
      const rate = (int(1_000_000, 200_000_000) / 1_000_000).toFixed(6);
      const parts: number[] = [];
      let left = totalCents;
      while (left > 0) {
        const part = Math.min(left, int(1, Math.max(1, Math.ceil(left / int(1, 4)))));
        parts.push(part);
        left -= part;
      }
      const credits = parts.map((c) => (c / 100).toFixed(2));
      const total = (totalCents / 100).toFixed(2);
      const originalNpr = toNpr(new Dec(total), 'INR', rate);
      const steps = newSteps(total, rate, credits);
      let running = new Dec(0);
      let creditedCents = 0;
      steps.forEach((s, i) => {
        creditedCents += parts[i]!;
        running = running.plus(s);
        expect(new Dec(s).gt(0), `${total} @ ${rate} step ${i} ${s}`).toBe(true);
        const share = originalNpr.times(creditedCents).dividedBy(totalCents);
        expect(running.toFixed(2)).toBe(share.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2));
      });
      expect(running.toFixed(2), `${total} @ ${rate} ${credits.join(',')}`).toBe(
        originalNpr.toFixed(2),
      );
    }
  });
});
