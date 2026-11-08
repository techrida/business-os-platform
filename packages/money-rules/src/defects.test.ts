// One regression test per old defect that a pure calculator can own.
//
// Covered here: D1 (unbalanced discount journal), per-line VAT rounding drift, float rounding,
// the Estimates path that skipped the 12% rule, and the Figma mock-up's wrong 18% sum.
// Not covered, because they are database, route or authorisation concerns outside a pure
// package (see the P3 architect's regression list): D2 invitation escalation, D3 IDOR on
// lists, D4 double-posting races, D5 payment on a non-issued invoice, D6 void leaving the
// posting live, D7 clients seeing drafts, and count+1 numbering.
import { describe, expect, it } from 'vitest';

import { Dec, moneyToString as s, parseMoney } from './money.js';
import { priceDocument, type DocInput } from './pricing.js';
import type { TaxCode } from './tax.js';

const common = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const taxCodes: TaxCode[] = [
  { ...common, code: 'VAT13', kind: 'vat', rateBp: 1300 },
  { ...common, code: 'VAT18', kind: 'vat', rateBp: 1800 },
];
const asOf = '2026-11-08';

/** Sum of Dr and Cr for the issue journal built the way the new design does it. */
function newJournal(doc: DocInput) {
  const p = priceDocument(doc, taxCodes);
  return { debit: p.total, credit: p.taxableTotal.plus(p.vatTotal), priced: p };
}

/**
 * The old code (ANALYSIS D1): `total = subtotal - discount + tax`, but the journal debited AR for
 * `total` and credited Income for `subtotal` and VAT for the tax.
 */
function oldJournal(doc: DocInput) {
  const p = priceDocument(doc, taxCodes);
  return { debit: p.total, credit: p.subtotal.plus(p.vatTotal), discount: p.discountTotal };
}

describe('D1: the invoice journal is unbalanced when a document discount is set', () => {
  const discounted: DocInput = {
    currency: 'NPR',
    asOf,
    lines: [{ qty: '1', unitPrice: '1880000.00', taxCode: 'VAT13' }],
    discount: { kind: 'percent', percent: '5' },
  };

  it('the old formula is short by exactly the discount (this is the bug)', () => {
    const old = oldJournal(discounted);
    expect(s(old.debit)).toBe('2018180.00');
    expect(s(old.credit)).toBe('2112180.00');
    expect(old.credit.minus(old.debit).toFixed(2)).toBe(old.discount.toFixed(2));
    expect(old.discount.gt(0)).toBe(true);
  });

  it('the new totals balance: Dr total = Cr (revenue net of discount + VAT)', () => {
    const j = newJournal(discounted);
    expect(s(j.debit)).toBe(s(j.credit));
  });

  it('balances for a line discount, a header discount and mixed tax codes together', () => {
    const j = newJournal({
      currency: 'NPR',
      asOf,
      lines: [
        {
          qty: '3',
          unitPrice: '33333.33',
          taxCode: 'VAT13',
          discount: { kind: 'percent', percent: '7.5' },
        },
        {
          qty: '1',
          unitPrice: '999.99',
          taxCode: 'VAT18',
          discount: { kind: 'amount', amount: '99.99' },
        },
      ],
      discount: { kind: 'percent', percent: '3.3333' },
    });
    expect(s(j.debit)).toBe(s(j.credit));
  });

  it('the NPR side balances too: total = taxable + VAT after C-2 rounding', () => {
    const p = priceDocument(
      {
        currency: 'USD',
        asOf,
        fxRate: '133.456789',
        lines: [{ qty: '7', unitPrice: '123.45', taxCode: 'VAT13' }],
        discount: { kind: 'percent', percent: '4.5' },
      },
      taxCodes,
    );
    expect(s(p.npr.taxableNpr.plus(p.npr.vatNpr))).toBe(s(p.npr.totalNpr));
  });
});

describe('per-line VAT rounding drift (P2 common mistake 2)', () => {
  it('VAT is rounded once per bucket, so "13% of taxable" checks out on a calculator', () => {
    const p = priceDocument(
      {
        currency: 'NPR',
        asOf,
        lines: ['10.04', '10.04', '10.04'].map((unitPrice) => ({
          qty: '1',
          unitPrice,
          taxCode: 'VAT13',
        })),
      },
      taxCodes,
    );
    const perLine = ['10.04', '10.04', '10.04']
      .map((v) => parseMoney(new Dec(v).times('0.13').toString()))
      .reduce((a, b) => a.plus(b), new Dec(0));
    expect(s(perLine)).toBe('3.93'); // the drift per-line rounding would have printed
    expect(s(p.vatTotal)).toBe('3.92'); // round2(30.12 x 13%)
    expect(s(p.vatTotal)).toBe(s(new Dec('30.12').times('0.13')));
  });
});

describe('no floats (the old `Decimal(14,2)` storage was fine; the arithmetic must be too)', () => {
  it('1.005 rounds to 1.01, where a JS float rounds it to 1.00', () => {
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(s(parseMoney('1.005'))).toBe('1.01');
  });

  it('0.1 + 0.2 is exactly 0.3 in a priced document', () => {
    const p = priceDocument(
      {
        currency: 'NPR',
        asOf,
        lines: [
          { qty: '1', unitPrice: '0.10', taxCode: 'VAT13' },
          { qty: '1', unitPrice: '0.20', taxCode: 'VAT13' },
        ],
      },
      taxCodes,
    );
    expect(s(p.subtotal)).toBe('0.30');
  });
});

describe('old Estimates skipped approval and the 12% rule', () => {
  it('a 12.5% discount is always flagged, whatever the document is called', () => {
    const p = priceDocument(
      {
        currency: 'NPR',
        asOf,
        lines: [{ qty: '1', unitPrice: '2000000.00', taxCode: 'VAT13' }],
        discount: { kind: 'percent', percent: '12.5' },
      },
      taxCodes,
    );
    expect(p.discountApprovalRequired).toBe(true);
  });
});

describe('Figma mock-up showed wrong sums (P2 contradiction C13)', () => {
  it('18% of 21,20,000 is 3,81,600, not 3,78,000', () => {
    const p = priceDocument(
      {
        currency: 'NPR',
        asOf,
        lines: [{ qty: '1', unitPrice: '2120000.00', taxCode: 'VAT18' }],
      },
      taxCodes,
    );
    expect(s(p.vatTotal)).toBe('381600.00');
    expect(s(p.total)).toBe('2501600.00');
  });
});
