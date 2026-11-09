// settlementOf, agingBucket and allocationFx. Day counts are worked out by hand; NPR oracles
// are BigInt paisa arithmetic, not the code under test.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Dec, moneyToString as s } from './money.js';
import { agingBucket, allocationFx, settlementOf, type FxOpenSide } from './settlement.js';

const d = (text: string) => new Dec(text);
const paisa = (value: Dec): bigint => BigInt(value.times(100).toFixed(0));
const fromPaisa = (value: bigint): Dec => new Dec(value.toString()).div(100);

describe('agingBucket', () => {
  it.each([
    ['2025-12-20', 'current'], // not due yet
    ['2026-01-01', 'current'], // due today
    ['2026-01-02', '1-15'], // 1 day
    ['2026-01-16', '1-15'], // 15
    ['2026-01-17', '16-30'], // 16
    ['2026-01-31', '16-30'], // 30
    ['2026-02-01', '31-60'], // 31
    ['2026-03-02', '31-60'], // 60
    ['2026-03-03', '61-90'], // 61
    ['2026-04-01', '61-90'], // 90
    ['2026-04-02', '90+'], // 91
    ['2027-01-01', '90+'],
  ])('a receivable due 2026-01-01 is %s -> %s', (today, expected) => {
    expect(agingBucket('2026-01-01', today)).toBe(expected);
  });

  it('counts 29 February in a leap year', () => {
    expect(agingBucket('2024-02-28', '2024-03-15')).toBe('16-30'); // 16 days
    expect(agingBucket('2023-02-28', '2023-03-15')).toBe('1-15'); // 15 days
  });

  it('refuses dates that are not ISO calendar dates', () => {
    expect(() => agingBucket('2026-02-30', '2026-03-01')).toThrow(RangeError);
    expect(() => agingBucket('2026-01-01', '2026-1-02')).toThrow(RangeError);
  });
});

describe('settlementOf', () => {
  const due = '2026-01-31';
  const before = '2026-01-15';
  const after = '2026-02-01';

  it.each([
    // [open, credited, today, expected]
    ['100.00', '0.00', before, 'unpaid'],
    ['40.00', '0.00', before, 'partly_paid'],
    ['0.00', '0.00', before, 'paid'],
    ['100.00', '0.00', after, 'overdue'],
    ['40.00', '0.00', after, 'overdue'],
    ['0.00', '0.00', after, 'paid'],
    ['100.00', '0.00', due, 'unpaid'], // due today is not overdue
    ['0.00', '100.00', before, 'credited'],
    ['0.00', '100.00', after, 'credited'],
    ['0.00', '30.00', before, 'paid'], // 30 credited, 70 paid
    ['70.00', '30.00', before, 'unpaid'], // credited in part, nothing paid
    ['70.00', '30.00', after, 'overdue'],
    ['50.00', '30.00', before, 'partly_paid'], // 30 credited, 20 paid
  ])('total 100.00, open %s, credited %s, today %s -> %s', (open, credited, today, expected) => {
    expect(
      settlementOf({
        total: d('100.00'),
        openAmount: d(open),
        credited: d(credited),
        dueDate: due,
        today,
      }),
    ).toBe(expected);
  });

  it('refuses open + credited above the total, and negative amounts', () => {
    const base = { total: d('100.00'), dueDate: due, today: before };
    expect(() => settlementOf({ ...base, openAmount: d('70.01'), credited: d('30.00') })).toThrow(
      RangeError,
    );
    expect(() => settlementOf({ ...base, openAmount: d('-1.00'), credited: d('0') })).toThrow(
      RangeError,
    );
    expect(() => settlementOf({ ...base, openAmount: d('1.00'), credited: d('-1') })).toThrow(
      RangeError,
    );
  });

  it('property: an open invoice is overdue exactly when its aging bucket is not current', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -200, max: 400 }),
        fc.integer({ min: 1, max: 10000 }),
        (offset, open) => {
          const today = new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
          const state = settlementOf({
            total: d('100.00'),
            openAmount: fromPaisa(BigInt(open)),
            credited: d('0'),
            dueDate: '2026-01-01',
            today,
          });
          expect(state === 'overdue').toBe(agingBucket('2026-01-01', today) !== 'current');
        },
      ),
    );
  });
});

describe('allocationFx', () => {
  it('is all NPR with no difference for an NPR invoice and payment', () => {
    const fx = allocationFx(d('1000.00'), '1', '1');
    expect([s(fx.arCredit), s(fx.advanceDebit), s(fx.fxDiff)]).toEqual([
      '1000.00',
      '1000.00',
      '0.00',
    ]);
  });

  it('books a gain when the payment rate is higher and a loss when it is lower', () => {
    const gain = allocationFx(d('100.00'), '133.45', '134.00');
    expect([s(gain.arCredit), s(gain.advanceDebit), s(gain.fxDiff)]).toEqual([
      '13345.00',
      '13400.00',
      '55.00',
    ]);
    const loss = allocationFx(d('100.01'), '133.45', '133.00');
    // 100.01 x 133.45 = 13,346.3345 -> 13,346.33; 100.01 x 133 = 13,301.33
    expect([s(loss.arCredit), s(loss.advanceDebit), s(loss.fxDiff)]).toEqual([
      '13346.33',
      '13301.33',
      '-45.00',
    ]);
  });

  it('with the open amounts, the piece that clears an invoice takes its last NPR', () => {
    // USD 0.06 at 1.5 is NPR 0.09, but six pieces of 0.01 would each round 0.015 up to 0.02.
    expect(s(allocationFx(d('0.01'), '1.5', '1.5').arCredit)).toBe('0.02');
    let item: FxOpenSide = { amount: d('0.06'), npr: d('0.09') };
    const credits: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const fx = allocationFx(d('0.01'), '1.5', '1.5', { item });
      credits.push(s(fx.arCredit));
      item = { amount: item.amount.minus('0.01'), npr: item.npr.minus(fx.arCredit) };
    }
    expect(credits).toEqual(['0.02', '0.02', '0.02', '0.02', '0.01', '0.00']);
    expect(s(item.npr)).toBe('0.00');
  });

  it('refuses a zero allocation, one above the open amount, and a bad rate', () => {
    expect(() => allocationFx(d('0'), '1', '1')).toThrow(RangeError);
    expect(() =>
      allocationFx(d('10.01'), '1', '1', { item: { amount: d('10.00'), npr: d('10.00') } }),
    ).toThrow(RangeError);
    expect(() => allocationFx(d('1.00'), '0', '1')).toThrow(RangeError);
    expect(() => allocationFx(d('1.00'), '1', '1.0000001')).toThrow(RangeError);
  });

  it('property: an invoice and its payment settled in pieces both close to NPR 0', () => {
    const MICRO = 1_000_000n;
    /** NPR paisa of `amount` paisa at `rate` micro-units, rounded half up. */
    const npr = (amount: bigint, rate: bigint) => (amount * rate + MICRO / 2n) / MICRO;
    const rateText = (rate: bigint) => new Dec(rate.toString()).div(1_000_000).toFixed(6);
    const rate = fc.bigInt({ min: 1n, max: 200_000_000n });

    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 8 }),
        rate,
        rate,
        (pieces, itemRate, paymentRate) => {
          const total = pieces.reduce((a, b) => a + b, 0n);
          const invoiceNpr = npr(total, itemRate);
          const paymentNpr = npr(total, paymentRate);
          let item = { amount: total, npr: invoiceNpr };
          let payment = { amount: total, npr: paymentNpr };
          let fxTotal = 0n;
          for (const piece of pieces) {
            const fx = allocationFx(fromPaisa(piece), rateText(itemRate), rateText(paymentRate), {
              item: { amount: fromPaisa(item.amount), npr: fromPaisa(item.npr) },
              payment: { amount: fromPaisa(payment.amount), npr: fromPaisa(payment.npr) },
            });
            const [ar, adv, diff] = [paisa(fx.arCredit), paisa(fx.advanceDebit), paisa(fx.fxDiff)];
            expect(adv - ar - diff).toBe(0n); // each entry balances
            expect(ar >= 0n && adv >= 0n).toBe(true);
            item = { amount: item.amount - piece, npr: item.npr - ar };
            payment = { amount: payment.amount - piece, npr: payment.npr - adv };
            fxTotal += diff;
          }
          expect(item.npr).toBe(0n);
          expect(payment.npr).toBe(0n);
          expect(fxTotal).toBe(paymentNpr - invoiceNpr);
        },
      ),
      { numRuns: 2000 },
    );
  });
});
