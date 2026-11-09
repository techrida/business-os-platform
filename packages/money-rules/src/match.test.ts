import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_TOLERANCE, evaluateLine, type MatchLineInput } from './match.js';
import { Dec } from './money.js';

const line = (over: Partial<MatchLineInput> = {}): MatchLineInput => ({
  orderedQty: '10',
  receivedQty: '10',
  billedQty: '10',
  poPrice: '1000.00',
  billPrice: '1000.00',
  poTax: '1300.00',
  billTax: '1300.00',
  ...over,
});

/** One unit, so the price figures are the line amounts. */
const one = (poPrice: string, billPrice: string): MatchLineInput =>
  line({ orderedQty: '1', receivedQty: '1', billedQty: '1', poPrice, billPrice });

describe('evaluateLine (AD6 defaults: qty 0%, price min(2%, NPR 500), tax exact)', () => {
  it('uses the AD6 defaults', () => {
    expect(DEFAULT_MATCH_TOLERANCE).toEqual({ qtyPct: '0', pricePct: '2', priceNpr: '500' });
  });

  it('passes a bill that equals the order and the receipt', () => {
    const result = evaluateLine(line());
    expect(result.withinTolerance).toBe(true);
    expect(result.qtyVariance.toFixed(4)).toBe('0.0000');
    expect(result.priceVariance.toFixed(2)).toBe('0.00');
    expect(result.taxVariance.toFixed(2)).toBe('0.00');
  });

  it('accepts +2% on 10,000 (a 200.00 variance is under the 500 cap)', () => {
    const result = evaluateLine(one('10000.00', '10200.00'));
    expect(result.priceVariance.toFixed(2)).toBe('200.00');
    expect(result.priceWithin).toBe(true);
    expect(result.withinTolerance).toBe(true);
  });

  it('rejects +2% on 100,000 (2,000.00 exceeds the NPR 500 cap)', () => {
    const result = evaluateLine(one('100000.00', '102000.00'));
    expect(result.priceVariance.toFixed(2)).toBe('2000.00');
    expect(result.priceWithin).toBe(false);
    expect(result.withinTolerance).toBe(false);
  });

  it('puts the edges inside: exactly 2% of a small line and exactly NPR 500 of a large one', () => {
    expect(evaluateLine(one('10000.00', '10200.00')).priceWithin).toBe(true);
    expect(evaluateLine(one('100000.00', '100500.00')).priceWithin).toBe(true);
    expect(evaluateLine(one('10000.00', '10200.01')).priceWithin).toBe(false);
    expect(evaluateLine(one('100000.00', '100500.01')).priceWithin).toBe(false);
  });

  it('measures price per line, so the unit price times the billed quantity must stay in tolerance', () => {
    // 100 units at 100.00 = 10,000.00; a bill of 102.01 each is 201.00 over, past 2% = 200.00.
    const base = line({
      orderedQty: '100',
      receivedQty: '100',
      billedQty: '100',
      poPrice: '100.00',
    });
    expect(evaluateLine({ ...base, billPrice: '102.00' }).priceWithin).toBe(true);
    expect(evaluateLine({ ...base, billPrice: '102.01' }).priceWithin).toBe(false);
  });

  it('treats a price below the order the same as one above it (the band is symmetric)', () => {
    expect(evaluateLine(one('100000.00', '99500.00')).priceWithin).toBe(true);
    expect(evaluateLine(one('100000.00', '99499.99')).priceWithin).toBe(false);
  });

  it('rejects any quantity billed over the quantity received', () => {
    const result = evaluateLine(line({ billedQty: '10.0001' }));
    expect(result.qtyVariance.toFixed(4)).toBe('0.0001');
    expect(result.qtyWithin).toBe(false);
    expect(result.withinTolerance).toBe(false);
  });

  it('accepts a bill for less than was received', () => {
    expect(evaluateLine(line({ billedQty: '9' })).withinTolerance).toBe(true);
  });

  it('rejects billing against nothing received', () => {
    expect(evaluateLine(line({ receivedQty: '0', billedQty: '1' })).withinTolerance).toBe(false);
    expect(evaluateLine(line({ receivedQty: '0', billedQty: '0' })).withinTolerance).toBe(true);
  });

  it('reports receipt against the order without failing the match on it', () => {
    const result = evaluateLine(line({ orderedQty: '8', receivedQty: '10', billedQty: '10' }));
    expect(result.orderedQtyVariance.toFixed(4)).toBe('2.0000');
    expect(result.withinTolerance).toBe(true);
  });

  it('requires tax to match to the paisa', () => {
    expect(evaluateLine(line({ billTax: '1300.01' })).taxWithin).toBe(false);
    expect(evaluateLine(line({ billTax: '1299.99' })).taxWithin).toBe(false);
    expect(evaluateLine(line({ billTax: '1300.00' })).taxWithin).toBe(true);
    expect(evaluateLine(line({ billTax: '1300.01' })).withinTolerance).toBe(false);
  });

  it('takes the tolerance from settings', () => {
    const wide = { qtyPct: '5', pricePct: '10', priceNpr: '5000' };
    const input = line({ billedQty: '10.5', billPrice: '1100.00' });
    // 10.5 x 1100 = 11,550 against 10.5 x 1000 = 10,500: 1,050 over, inside 10% and the 5,000 cap.
    expect(evaluateLine(input, wide).withinTolerance).toBe(true);
    expect(evaluateLine(input).qtyWithin).toBe(false);
    expect(evaluateLine(input).priceWithin).toBe(false);
    expect(evaluateLine(input).withinTolerance).toBe(false);
    // A 5% quantity allowance on 10 received is 10.5 billed; 10.5001 is out.
    expect(evaluateLine(line({ billedQty: '10.5001' }), wide).qtyWithin).toBe(false);
  });

  it('accepts Dec values as well as strings', () => {
    expect(evaluateLine(line({ billedQty: new Dec('10') })).withinTolerance).toBe(true);
  });

  it('rejects numbers, negatives and bad tolerances', () => {
    expect(() => evaluateLine(line({ billPrice: 1000 as unknown as string }))).toThrow(TypeError);
    expect(() => evaluateLine(line({ billedQty: '-1' }))).toThrow(RangeError);
    expect(() => evaluateLine(line({ poPrice: '-1.00' }))).toThrow(RangeError);
    expect(() => evaluateLine(line(), { qtyPct: '-1', pricePct: '2', priceNpr: '500' })).toThrow(
      RangeError,
    );
    expect(() => evaluateLine(line(), { qtyPct: '0', pricePct: 'x', priceNpr: '500' })).toThrow(
      RangeError,
    );
  });
});

describe('evaluateLine properties', () => {
  const cents = fc.integer({ min: 1, max: 1_000_000_000 }); // paisa
  const qty = fc.integer({ min: 0, max: 100_000 }); // whole units
  const toMoney = (p: number) => new Dec(p).div(100).toFixed(2);

  it('any billed quantity above received is outside; at or below is inside (qty only)', () => {
    fc.assert(
      fc.property(qty, qty, (received, billed) => {
        const result = evaluateLine(
          line({
            orderedQty: String(received),
            receivedQty: String(received),
            billedQty: String(billed),
          }),
        );
        expect(result.qtyWithin).toBe(billed <= received);
      }),
      { numRuns: 1000 },
    );
  });

  it('price is within exactly when |variance| <= min(2% of the PO line, 500), checked in paisa', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: -2_000_000, max: 2_000_000 }), (po, delta) => {
        const bill = Math.max(0, po + delta);
        const result = evaluateLine(one(toMoney(po), toMoney(bill)));
        // |bill - po| <= min(po * 2 / 100, 50_000 paisa)
        const diff = Math.abs(bill - po);
        const expected = diff * 100 <= po * 2 && diff <= 50_000;
        expect(result.priceWithin).toBe(expected);
      }),
      { numRuns: 2000 },
    );
  });

  it('tax is within exactly when the two amounts are equal', () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        const result = evaluateLine(line({ poTax: toMoney(a), billTax: toMoney(b) }));
        expect(result.taxWithin).toBe(a === b);
      }),
      { numRuns: 1000 },
    );
  });

  it('tax is within when both amounts are equal, across the whole range', () => {
    fc.assert(
      fc.property(cents, (a) => {
        expect(evaluateLine(line({ poTax: toMoney(a), billTax: toMoney(a) })).taxWithin).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('withinTolerance is the conjunction of the three checks', () => {
    fc.assert(
      fc.property(qty, qty, cents, cents, cents, cents, (rec, billed, po, bill, pt, bt) => {
        const r = evaluateLine(
          line({
            orderedQty: String(rec),
            receivedQty: String(rec),
            billedQty: String(billed),
            poPrice: toMoney(po),
            billPrice: toMoney(bill),
            poTax: toMoney(pt),
            billTax: toMoney(bt),
          }),
        );
        expect(r.withinTolerance).toBe(r.qtyWithin && r.priceWithin && r.taxWithin);
      }),
      { numRuns: 1000 },
    );
  });
});
