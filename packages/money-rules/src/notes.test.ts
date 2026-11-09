// creditNoteSlice. Expected figures are worked out by hand or with BigInt paisa arithmetic.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Dec, moneyToString as s } from './money.js';
import { creditNoteSlice } from './notes.js';
import type { TaxBucket, TaxCode } from './tax.js';

const common = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const VAT13: TaxCode = { ...common, code: 'VAT13', kind: 'vat', rateBp: 1300 };
const EXEMPT: TaxCode = { ...common, code: 'EXEMPT', kind: 'exempt', rateBp: 0 };
const RC13: TaxCode = { ...common, code: 'RC13', kind: 'reverse_charge', rateBp: 1300 };

const d = (text: string) => new Dec(text);
const paisa = (value: Dec): bigint => BigInt(value.times(100).toFixed(0));
const fromPaisa = (value: bigint): string => new Dec(value.toString()).div(100).toFixed(2);
const bucket = (taxCode: TaxCode, taxable: string, vat: string, rc = '0'): TaxBucket => ({
  taxCode,
  taxable: d(taxable),
  vat: d(vat),
  reverseChargeVat: d(rc),
});

/** The R20 advance invoice: taxable 1,786,000.00, VAT 232,180.00, total 2,018,180.00. */
const advance = [bucket(VAT13, '1786000.00', '232180.00')];

describe('creditNoteSlice by lines', () => {
  it('crediting the whole advance takes back exactly its taxable and VAT', () => {
    const note = creditNoteSlice(advance, {
      kind: 'lines',
      lines: [{ taxCode: 'VAT13', taxable: d('1786000.00') }],
    });
    expect(s(note.taxableTotal)).toBe('1786000.00');
    expect(s(note.vatTotal)).toBe('232180.00');
    expect(s(note.total)).toBe('2018180.00');
  });

  it('credits VAT in proportion to the bucket: 100,000.00 of the advance carries 13,000.00', () => {
    const note = creditNoteSlice(advance, {
      kind: 'lines',
      lines: [
        { taxCode: 'VAT13', taxable: d('60000.00') },
        { taxCode: 'VAT13', taxable: d('40000.00') },
      ],
    });
    expect(s(note.buckets[0]!.taxable)).toBe('100000.00');
    expect(s(note.buckets[0]!.vat)).toBe('13000.00');
  });

  it('returns the VAT actually charged, not the rate, when a bucket absorbed a paisa', () => {
    const absorbed = [bucket(VAT13, '100.00', '13.01'), bucket(EXEMPT, '50.00', '0')];
    const whole = creditNoteSlice(absorbed, {
      kind: 'lines',
      lines: [{ taxCode: 'VAT13', taxable: d('100.00') }],
    });
    expect(s(whole.buckets[0]!.vat)).toBe('13.01');
    // The exempt bucket is not credited.
    expect(s(whole.buckets[1]!.taxable)).toBe('0.00');
    expect(s(whole.total)).toBe('113.01');

    const half = creditNoteSlice(absorbed, {
      kind: 'lines',
      lines: [{ taxCode: 'VAT13', taxable: d('50.00') }],
    });
    expect(s(half.buckets[0]!.vat)).toBe('6.51'); // 6.505 rounds half up
  });

  it('carries reverse-charge VAT in proportion, outside the total', () => {
    const note = creditNoteSlice([bucket(RC13, '1000.00', '0', '130.00')], {
      kind: 'lines',
      lines: [{ taxCode: 'RC13', taxable: d('250.00') }],
    });
    expect(s(note.buckets[0]!.reverseChargeVat)).toBe('32.50');
    expect(s(note.total)).toBe('250.00');
  });

  it('refuses a tax code not on the invoice, too much taxable, and negative amounts', () => {
    const lines = (taxCode: string, taxable: string) => ({
      kind: 'lines' as const,
      lines: [{ taxCode, taxable: d(taxable) }],
    });
    expect(() => creditNoteSlice(advance, lines('EXEMPT', '1.00'))).toThrow(RangeError);
    expect(() => creditNoteSlice(advance, lines('VAT13', '1786000.01'))).toThrow(RangeError);
    expect(() => creditNoteSlice(advance, lines('VAT13', '-1.00'))).toThrow(RangeError);
    expect(() => creditNoteSlice(advance, lines('VAT13', '1.001'))).toThrow(RangeError);
  });
});

describe('creditNoteSlice by amount', () => {
  it('splits 1,130.00 off the advance into taxable 1,000.00 and VAT 130.00', () => {
    const note = creditNoteSlice(advance, { kind: 'amount', amount: d('1130.00') });
    expect(s(note.taxableTotal)).toBe('1000.00');
    expect(s(note.vatTotal)).toBe('130.00');
    expect(s(note.total)).toBe('1130.00');
  });

  it('crediting the full total returns the invoice exactly', () => {
    const invoice = [bucket(VAT13, '100.01', '13.00'), bucket(EXEMPT, '0.01', '0')];
    const note = creditNoteSlice(invoice, { kind: 'amount', amount: d('113.02') });
    expect(note.buckets.map((b) => [s(b.taxable), s(b.vat)])).toEqual([
      ['100.01', '13.00'],
      ['0.01', '0.00'],
    ]);
  });

  it('refuses more than the invoice total and negative amounts', () => {
    expect(() => creditNoteSlice(advance, { kind: 'amount', amount: d('2018180.01') })).toThrow(
      RangeError,
    );
    expect(() => creditNoteSlice(advance, { kind: 'amount', amount: d('-0.01') })).toThrow(
      RangeError,
    );
  });

  it('property: the note is the amount exactly, each part within a paisa of its share', () => {
    const component = fc.bigInt({ min: 0n, max: 10n ** 12n });
    fc.assert(
      fc.property(
        fc.array(fc.record({ taxable: component, vat: component }), { minLength: 1, maxLength: 4 }),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        (parts, per) => {
          const invoice = parts.map((p, i) =>
            bucket({ ...VAT13, code: `T${i}` }, fromPaisa(p.taxable), fromPaisa(p.vat)),
          );
          const invoiceTotal = parts.reduce((acc, p) => acc + p.taxable + p.vat, 0n);
          const amount = (invoiceTotal * per) / 10n ** 6n;
          const note = creditNoteSlice(invoice, { kind: 'amount', amount: d(fromPaisa(amount)) });
          expect(paisa(note.total)).toBe(amount);
          note.buckets.forEach((b, i) => {
            for (const [got, whole] of [
              [paisa(b.taxable), parts[i]!.taxable],
              [paisa(b.vat), parts[i]!.vat],
            ] as const) {
              expect(got).toBeLessThanOrEqual(whole);
              if (invoiceTotal > 0n) {
                // |got - amount x whole / total| < 1 paisa, compared without dividing
                const diff = got * invoiceTotal - amount * whole;
                expect(diff < invoiceTotal && diff > -invoiceTotal).toBe(true);
              }
            }
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
});
