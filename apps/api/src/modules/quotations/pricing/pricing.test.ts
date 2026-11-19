// Unit tests of the pure quotation pricing map (money-rules priceDocument -> PricedVersion). Every case also
// runs expectDbArithmetic, which re-checks the quotation_versions and quotation_lines CHECK constraints
// (taxable = subtotal - discount, total = taxable + tax, gross = round(qty x price, 2), taxable = gross - alloc).
import { Dec } from '@bos/locale';
import { describe, expect, it } from 'vitest';

import { priceQuotation, type FxSnapshot } from './pricing';
import type { PricedVersion, PricingInput, PricingLineInput } from './pricing.types';
import type { TaxCodeRow } from './tax-codes.resolver';

const NPR_FX: FxSnapshot = { rate: '1', source: null, date: null };
const always = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const VAT13: TaxCodeRow = {
  ...always,
  id: 'tc-vat',
  code: 'VAT13',
  name: 'VAT 13%',
  kind: 'vat',
  rateBp: 1300,
};
const EXEMPT: TaxCodeRow = {
  ...always,
  id: 'tc-ex',
  code: 'EXEMPT',
  name: 'Exempt',
  kind: 'exempt',
  rateBp: 0,
};
const PERIODS = [VAT13, EXEMPT];

const line = (
  lineNo: number,
  quantity: string,
  unitPrice: string,
  extra: Partial<PricingLineInput> = {},
) => ({
  lineNo,
  description: `Line ${lineNo}`,
  uom: 'job',
  quantity,
  unitPrice,
  taxCodeId: VAT13.id,
  ...extra,
});

const input = (lines: PricingLineInput[], extra: Partial<PricingInput> = {}): PricingInput => ({
  currency: 'NPR',
  issueDate: '2026-11-09',
  lines,
  discount: null,
  ...extra,
});

const MONEY = /^\d+\.\d{2}$/;

/** The DB CHECK arithmetic, exactly as quotation_versions and quotation_lines state it. */
function expectDbArithmetic(pv: PricedVersion): void {
  const c = pv.columns;
  for (const v of [
    c.subtotal,
    c.discountAmount,
    c.taxableAmount,
    c.taxAmount,
    c.total,
    c.amountNpr,
    c.nprTaxableAmount,
  ]) {
    expect(v).toMatch(MONEY);
  }
  expect(new Dec(c.taxableAmount).eq(new Dec(c.subtotal).minus(c.discountAmount))).toBe(true);
  expect(new Dec(c.total).eq(new Dec(c.taxableAmount).plus(c.taxAmount))).toBe(true);
  let allocs = new Dec(0);
  let taxables = new Dec(0);
  for (const l of pv.lines) {
    expect(l.quantity).toMatch(/^\d+\.\d{4}$/);
    for (const v of [l.unitPrice, l.gross, l.discountAlloc, l.taxable]) expect(v).toMatch(MONEY);
    const rounded = new Dec(l.quantity).times(l.unitPrice).toDecimalPlaces(2, Dec.ROUND_HALF_UP);
    expect(new Dec(l.gross).eq(rounded)).toBe(true);
    expect(new Dec(l.taxable).eq(new Dec(l.gross).minus(l.discountAlloc))).toBe(true);
    allocs = allocs.plus(l.discountAlloc);
    taxables = taxables.plus(l.taxable);
  }
  expect(allocs.eq(c.discountAmount)).toBe(true);
  expect(taxables.eq(c.taxableAmount)).toBe(true);
  const summaryTax = pv.taxSummary.reduce((sum, row) => sum.plus(row.tax), new Dec(0));
  expect(summaryTax.eq(c.taxAmount)).toBe(true);
  expect(new Dec(c.nprTaxableAmount).lte(c.amountNpr)).toBe(true);
}

describe('priceQuotation: the P2 golden case (architect section 2.6)', () => {
  const pv = priceQuotation(
    input(
      [
        line(1, '1', '1800000.00'),
        line(2, '1', '700000.00'),
        line(3, '3', '33333.33', { taxCodeId: EXEMPT.id }),
      ],
      {
        discount: { mode: 'pct', value: '8' },
      },
    ),
    PERIODS,
    NPR_FX,
  );

  it('totals 2,690,999.99 to the paisa with the leftover paisa on line 3', () => {
    expect(pv.columns).toMatchObject({
      subtotal: '2599999.99',
      discountAmount: '208000.00',
      taxableAmount: '2391999.99',
      taxAmount: '299000.00',
      total: '2690999.99',
      effectiveDiscountPct: '8.0000',
      amountNpr: '2690999.99',
      nprTaxableAmount: '2391999.99',
      fxRate: '1.000000',
      fxSource: null,
      fxDate: null,
      calcVersion: 1,
      internalCostTotal: null,
      marginPct: null,
    });
    expect(pv.lines.map((l) => [l.gross, l.discountAlloc, l.taxable])).toEqual([
      ['1800000.00', '144000.00', '1656000.00'],
      ['700000.00', '56000.00', '644000.00'],
      ['99999.99', '8000.00', '91999.99'],
    ]);
    expect(pv.lines[2]).toMatchObject({
      lineNo: 3,
      quantity: '3.0000',
      unitPrice: '33333.33',
      unitCost: null,
      catalogItemId: null,
    });
    expectDbArithmetic(pv);
  });

  it('writes one tax summary row per code with the label and rate copied', () => {
    expect(pv.taxSummary).toEqual([
      {
        taxCodeId: 'tc-vat',
        label: 'VAT 13%',
        rate: '13.0000',
        base: '2300000.00',
        tax: '299000.00',
      },
      { taxCodeId: 'tc-ex', label: 'Exempt', rate: '0.0000', base: '91999.99', tax: '0.00' },
    ]);
  });

  it('carries the unrounded discount percentage and the NPR amount in the facts', () => {
    expect(pv.facts).toMatchObject({
      amountNpr: '2690999.99',
      nprDiscountAmount: '208000.00',
      discountApprovalRequired: false,
      marginPct: null,
      currency: 'NPR',
    });
    // 208000 / 2599999.99 x 100 = 8.0000000031%: the facts keep the digits the stored column rounds away.
    expect(pv.facts.effectiveDiscountPct).toMatch(/^8\.000000030769/);
  });
});

describe('priceQuotation: foreign currency', () => {
  it('prices INR on the 1.6 peg with the C-2 NPR rounding (total and VAT rounded, taxable the difference)', () => {
    const fx: FxSnapshot = { rate: '1.6', source: 'NRB peg', date: '2020-01-01' };
    const pv = priceQuotation(
      input([line(1, '1', '1000.00'), line(2, '1', '0.05')], { currency: 'INR' }),
      PERIODS,
      fx,
    );
    // 1000.05 + VAT 130.01 (13% of 1000.05 = 130.0065) = 1130.06 INR -> 1808.10 NPR; VAT 208.02 NPR.
    expect(pv.columns).toMatchObject({
      total: '1130.06',
      taxAmount: '130.01',
      fxRate: '1.600000',
      fxSource: 'NRB peg',
      fxDate: '2020-01-01',
      amountNpr: '1808.10',
      nprTaxableAmount: '1600.08',
    });
    expect(pv.facts).toMatchObject({ amountNpr: '1808.10', currency: 'INR' });
    expectDbArithmetic(pv);
  });
});

describe('priceQuotation: the NPR discount amount fact', () => {
  const inr = (value: string) =>
    priceQuotation(
      input([line(1, '1', '1000.00')], { currency: 'INR', discount: { mode: 'amount', value } }),
      PERIODS,
      { rate: '1.6', source: 'NRB peg', date: '2020-01-01' },
    );

  it.each([
    ['100.05', '160.08'],
    ['0.03', '0.05'],
    ['0.00', '0.00'],
  ])(
    'converts an INR discount of %s at the snapshot rate, rounded half up, to %s NPR',
    (value, npr) => {
      const pv = inr(value);
      expect(pv.columns.discountAmount).toBe(value);
      expect(pv.facts.nprDiscountAmount).toBe(npr);
      expectDbArithmetic(pv);
    },
  );

  it('equals the discount amount for NPR', () => {
    const pv = priceQuotation(
      input([line(1, '1', '999.99')], { discount: { mode: 'pct', value: '7.5' } }),
      PERIODS,
      NPR_FX,
    );
    expect(pv.facts.nprDiscountAmount).toBe(pv.columns.discountAmount);
    expect(pv.facts.nprDiscountAmount).toBe('75.00');
  });
});

describe('priceQuotation: tax code by effective date', () => {
  const OLD: TaxCodeRow = { ...VAT13, id: 'tc-vat-old', effectiveTo: '2026-12-01' };
  const NEW: TaxCodeRow = {
    ...VAT13,
    id: 'tc-vat-new',
    name: 'VAT 15%',
    rateBp: 1500,
    effectiveFrom: '2026-12-01',
  };
  const price = (issueDate: string) =>
    priceQuotation(
      input([line(1, '1', '1000.00', { taxCodeId: OLD.id })], { issueDate }),
      [OLD, NEW],
      NPR_FX,
    );

  it('uses the old period on the day before the change, whichever period the line named', () => {
    const pv = price('2026-11-30');
    expect(pv.lines[0]!.taxCodeId).toBe('tc-vat-old');
    expect(pv.taxSummary).toEqual([
      {
        taxCodeId: 'tc-vat-old',
        label: 'VAT 13%',
        rate: '13.0000',
        base: '1000.00',
        tax: '130.00',
      },
    ]);
    expectDbArithmetic(pv);
  });

  it('uses the new period on the boundary day itself (effective_to is exclusive)', () => {
    const pv = price('2026-12-01');
    expect(pv.lines[0]!.taxCodeId).toBe('tc-vat-new');
    expect(pv.taxSummary).toEqual([
      {
        taxCodeId: 'tc-vat-new',
        label: 'VAT 15%',
        rate: '15.0000',
        base: '1000.00',
        tax: '150.00',
      },
    ]);
    expect(pv.columns.total).toBe('1150.00');
    expectDbArithmetic(pv);
  });

  it('refuses a line whose tax code id is not among the periods', () => {
    expect(() =>
      priceQuotation(input([line(1, '1', '1.00', { taxCodeId: 'nope' })]), PERIODS, NPR_FX),
    ).toThrow(RangeError);
  });

  it('refuses a date no period covers', () => {
    expect(() =>
      priceQuotation(input([line(1, '1', '1.00')], { issueDate: '1999-12-31' }), PERIODS, NPR_FX),
    ).toThrow(/no version in force/);
  });
});

describe('priceQuotation: the 12% discount fact is decided exactly', () => {
  const facts = (subtotal: string, discount: PricingInput['discount']) =>
    priceQuotation(input([line(1, '1', subtotal)], { discount }), PERIODS, NPR_FX);

  it.each([
    ['exactly 12% by amount', '1000.00', { mode: 'amount', value: '120.00' }, '12.0000', false],
    ['exactly 12% by percentage', '1000.00', { mode: 'pct', value: '12' }, '12.0000', false],
    ['12.0001% by amount', '1000000.00', { mode: 'amount', value: '120001.00' }, '12.0001', true],
    ['12.0001% by percentage', '1000000.00', { mode: 'pct', value: '12.0001' }, '12.0001', true],
    [
      '12.00001%, stored as 12.0000',
      '10000000.00',
      { mode: 'amount', value: '1200001.00' },
      '12.0000',
      true,
    ],
  ] as const)('%s', (_name, subtotal, discount, stored, required) => {
    const pv = facts(subtotal, discount);
    expect(pv.columns.effectiveDiscountPct).toBe(stored);
    expect(pv.facts.discountApprovalRequired).toBe(required);
    expectDbArithmetic(pv);
  });

  it('keeps the unrounded percentage that the stored text rounds to 12.0000', () => {
    expect(
      facts('10000000.00', { mode: 'amount', value: '1200001.00' }).facts.effectiveDiscountPct,
    ).toBe('12.00001');
  });
});

describe('priceQuotation: internal cost and margin', () => {
  const lines = [
    line(1, '2', '500.00', { unitCost: '300.00' }),
    line(2, '1', '1000.00', { unitCost: '600.00' }),
  ];

  it('computes the margin on taxable (after discount, before VAT) when every line has a cost', () => {
    const pv = priceQuotation(
      input(lines, { discount: { mode: 'pct', value: '10' } }),
      PERIODS,
      NPR_FX,
    );
    // (1800 - 1200) / 1800 x 100 = 33.3333
    expect(pv.columns).toMatchObject({
      taxableAmount: '1800.00',
      internalCostTotal: '1200.00',
      marginPct: '33.3333',
    });
    expect(pv.facts.marginPct).toBe('33.3333');
    expect(pv.lines.map((l) => l.unitCost)).toEqual(['300.00', '600.00']);
    expectDbArithmetic(pv);
  });

  it('uses the sum of half-up line costs for the total and margin', () => {
    const fractional = [
      line(1, '0.5', '1.00', { unitCost: '0.01' }),
      line(2, '0.5', '1.00', { unitCost: '0.01' }),
    ];
    const pv = priceQuotation(input(fractional), PERIODS, NPR_FX);
    expect(pv.columns).toMatchObject({ internalCostTotal: '0.02', marginPct: '98.0000' });
  });

  const { unitCost: _dropped, ...withoutCost } = lines[1]!;
  it.each([
    ['missing', withoutCost],
    ['null', { ...withoutCost, unitCost: null }],
  ])('is null when one line cost is %s', (_name, second: PricingLineInput) => {
    const pv = priceQuotation(input([lines[0]!, second]), PERIODS, NPR_FX);
    expect(pv.columns.internalCostTotal).toBeNull();
    expect(pv.columns.marginPct).toBeNull();
    expect(pv.facts.marginPct).toBeNull();
  });

  it('reports a margin in range as not out of range', () => {
    const pv = priceQuotation(input(lines), PERIODS, NPR_FX);
    expect(pv.facts.marginOutOfRange).toBe(false);
  });

  it('is null and flagged out of range when the cost is 20 times taxable (-1900%)', () => {
    const pv = priceQuotation(
      input([line(1, '1', '100.00', { unitCost: '2000.00' })]),
      PERIODS,
      NPR_FX,
    );
    expect(pv.columns.internalCostTotal).toBe('2000.00');
    expect(pv.columns.marginPct).toBeNull();
    expect(pv.facts).toMatchObject({ marginPct: null, marginOutOfRange: true });
  });

  it.each([
    ['109999.99', '-999.9999', false],
    ['110000.00', null, true],
  ])(
    'with cost %s on taxable 10000.00 the margin is %s (edge -999.9999 still fits)',
    (cost, margin, out) => {
      const pv = priceQuotation(
        input([line(1, '1', '10000.00', { unitCost: cost })]),
        PERIODS,
        NPR_FX,
      );
      expect(pv.columns.marginPct).toBe(margin);
      expect(pv.facts).toMatchObject({ marginPct: margin, marginOutOfRange: out });
    },
  );

  it('is not flagged out of range when the margin is unknown', () => {
    const pv = priceQuotation(input([line(1, '1', '100.00')]), PERIODS, NPR_FX);
    expect(pv.facts).toMatchObject({ marginPct: null, marginOutOfRange: false });
  });

  it('is null, not a division by zero, when the taxable amount is zero', () => {
    const pv = priceQuotation(input([line(1, '1', '0.00', { unitCost: '5.00' })]), PERIODS, NPR_FX);
    expect(pv.columns.internalCostTotal).toBe('5.00');
    expect(pv.columns.marginPct).toBeNull();
    expect(pv.facts.effectiveDiscountPct).toBe('0');
  });
});
