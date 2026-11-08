import { describe, expect, it } from 'vitest';

import {
  AMOUNT_NPR_BASIS,
  amountNpr,
  exceedsApprovalThresholdNpr,
  nprSnapshot,
  toNpr,
} from './fx.js';
import { Dec, moneyToString } from './money.js';

const d = (text: string) => new Dec(text);

describe('toNpr', () => {
  it('multiplies by the rate and rounds half up to 2dp', () => {
    expect(moneyToString(toNpr(d('1000.00'), 'INR', '1.6'))).toBe('1600.00'); // the NRB peg
    expect(moneyToString(toNpr(d('100.01'), 'USD', '133.45'))).toBe('13346.33');
    expect(moneyToString(toNpr(d('0.05'), 'USD', '0.1'))).toBe('0.01'); // 0.005 ties up
  });

  it('leaves NPR untouched and accepts only a rate of 1 (or none) for it', () => {
    expect(moneyToString(toNpr(d('12.34'), 'NPR'))).toBe('12.34');
    expect(moneyToString(toNpr(d('12.34'), 'NPR', '1.000000'))).toBe('12.34');
    expect(() => toNpr(d('12.34'), 'NPR', '2')).toThrow(RangeError);
  });

  it('demands a numeric(18,6) rate for INR and USD', () => {
    expect(() => toNpr(d('1'), 'USD')).toThrow(RangeError);
    expect(() => toNpr(d('1'), 'USD', '133.4567891')).toThrow(RangeError);
    expect(() => toNpr(d('1'), 'USD', '0')).toThrow(RangeError);
  });
});

describe('nprSnapshot (C-2: NPR total and VAT rounded, taxable = total - VAT)', () => {
  it('derives taxable from the two rounded figures, so total = taxable + VAT in NPR', () => {
    // total 1,130.00 (taxable 1,000.00 + VAT 130.00) at 133.333333:
    // total 150,666.66629 -> 150,666.67; VAT 17,333.33329 -> 17,333.33; taxable 133,333.34.
    // Converting the taxable amount on its own would give 133,333.33 and break the identity.
    const snap = nprSnapshot({
      total: d('1130.00'),
      vat: d('130.00'),
      currency: 'USD',
      fxRate: '133.333333',
    });
    expect(moneyToString(snap.totalNpr)).toBe('150666.67');
    expect(moneyToString(snap.vatNpr)).toBe('17333.33');
    expect(moneyToString(snap.taxableNpr)).toBe('133333.34');
    expect(snap.fxRate).toBe('133.333333');
  });

  it('for NPR the snapshot is the document itself with rate 1.000000', () => {
    const snap = nprSnapshot({ total: d('2018180.00'), vat: d('232180.00'), currency: 'NPR' });
    expect(moneyToString(snap.totalNpr)).toBe('2018180.00');
    expect(moneyToString(snap.taxableNpr)).toBe('1786000.00');
    expect(snap.fxRate).toBe('1.000000');
  });
});

describe('amountNpr and the approval threshold (C-6)', () => {
  it('names its basis: grand total including VAT, in NPR, before TDS', () => {
    expect(AMOUNT_NPR_BASIS).toBe('grand_total_incl_vat_before_tds');
  });

  it('is the grand total including VAT in NPR', () => {
    expect(moneyToString(amountNpr({ total: d('2018180.00'), currency: 'NPR' }))).toBe(
      '2018180.00',
    );
    expect(
      moneyToString(amountNpr({ total: d('1130.00'), currency: 'USD', fxRate: '133.333333' })),
    ).toBe('150666.67');
  });

  it('triggers only strictly above the threshold', () => {
    expect(exceedsApprovalThresholdNpr(d('100000.00'), '100000')).toBe(false);
    expect(exceedsApprovalThresholdNpr(d('100000.01'), '100000')).toBe(true);
    expect(exceedsApprovalThresholdNpr(d('1000000.00'), '1000000.00')).toBe(false);
    expect(exceedsApprovalThresholdNpr(d('1000000.01'), '1000000.00')).toBe(true);
  });

  it('compares the rounded NPR amount, so a USD total is judged in rupees', () => {
    // 7.50 USD at 133.333333 = 999.9999975 -> 1,000.00 NPR (not above 1,000).
    const converted = amountNpr({ total: d('7.50'), currency: 'USD', fxRate: '133.333333' });
    expect(moneyToString(converted)).toBe('1000.00');
    expect(exceedsApprovalThresholdNpr(converted, '1000')).toBe(false);
  });
});
