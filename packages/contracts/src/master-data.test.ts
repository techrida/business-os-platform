import { describe, expect, it } from 'vitest';

import {
  basisPointsToPercent,
  ChangeTaxCodeBodySchema,
  CreatePaymentTermBodySchema,
  CreateTaxCodeBodySchema,
  percentToBasisPoints,
  RetireTaxCodeBodySchema,
  TaxRatePercentSchema,
  UpdatePaymentTermBodySchema,
} from './master-data.js';

describe('tax rate percent and basis points', () => {
  it('converts exactly, with no floating point', () => {
    expect(percentToBasisPoints('13')).toBe(1300);
    expect(percentToBasisPoints('6.5')).toBe(650);
    expect(percentToBasisPoints('0.01')).toBe(1);
    expect(percentToBasisPoints('0.29')).toBe(29);
    expect(percentToBasisPoints('100')).toBe(10000);
    expect(percentToBasisPoints(' 12.50 ')).toBe(1250);
    expect(basisPointsToPercent(1300)).toBe('13');
    expect(basisPointsToPercent(650)).toBe('6.5');
    expect(basisPointsToPercent(1)).toBe('0.01');
    for (const bp of [0, 1, 29, 650, 1250, 1300, 9999, 10000]) {
      expect(percentToBasisPoints(basisPointsToPercent(bp))).toBe(bp);
    }
  });

  it('accepts 0 to 100 with up to two decimals only', () => {
    for (const ok of ['0', '13', '6.5', '0.01', '99.99', '100', '100.00']) {
      expect(TaxRatePercentSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '-1', '100.01', '101', '13.005', '1e2', '13%', 'abc']) {
      expect(TaxRatePercentSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('tax code bodies', () => {
  const create = {
    code: 'VAT13',
    name: 'VAT 13%',
    kind: 'vat',
    rate: '13',
    creditable: true,
    effectiveFrom: '2026-12-01',
  };

  it('accepts a VAT code with a positive rate and an exempt code at 0', () => {
    expect(CreateTaxCodeBodySchema.safeParse(create).success).toBe(true);
    expect(
      CreateTaxCodeBodySchema.safeParse({ ...create, code: 'EX', kind: 'exempt', rate: '0' })
        .success,
    ).toBe(true);
  });

  it('refuses a rate that does not suit the kind, a lower-case code and extra fields', () => {
    expect(CreateTaxCodeBodySchema.safeParse({ ...create, rate: '0' }).success).toBe(false);
    expect(CreateTaxCodeBodySchema.safeParse({ ...create, kind: 'zero' }).success).toBe(false);
    expect(CreateTaxCodeBodySchema.safeParse({ ...create, code: 'vat13' }).success).toBe(false);
    expect(CreateTaxCodeBodySchema.safeParse({ ...create, id: 'x' }).success).toBe(false);
  });

  it('a change carries no kind: the kind of a code is fixed', () => {
    const change = {
      name: 'VAT 15%',
      rate: '15',
      creditable: true,
      effectiveFrom: '2027-01-01',
      expectedPeriodId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 1,
    };
    expect(ChangeTaxCodeBodySchema.safeParse(change).success).toBe(true);
    // The period id is required: a version alone cannot tell two periods apart (each new one starts at 1).
    expect(
      ChangeTaxCodeBodySchema.safeParse({ ...change, expectedPeriodId: undefined }).success,
    ).toBe(false);
    expect(
      RetireTaxCodeBodySchema.safeParse({ effectiveTo: '2027-01-01', expectedVersion: 1 }).success,
    ).toBe(false);
    expect(ChangeTaxCodeBodySchema.safeParse({ ...change, kind: 'zero' }).success).toBe(false);
  });
});

describe('payment term bodies', () => {
  it('keeps the days to creation: an update takes only the name and retired', () => {
    expect(
      CreatePaymentTermBodySchema.safeParse({ code: 'NET45', name: 'Net 45', netDays: 45 }).success,
    ).toBe(true);
    expect(
      CreatePaymentTermBodySchema.safeParse({ code: 'NET400', name: 'Net 400', netDays: 400 })
        .success,
    ).toBe(false);
    expect(
      UpdatePaymentTermBodySchema.safeParse({ name: 'Net 45 days', expectedVersion: 2 }).success,
    ).toBe(true);
    expect(UpdatePaymentTermBodySchema.safeParse({ netDays: 30, expectedVersion: 2 }).success).toBe(
      false,
    );
    expect(UpdatePaymentTermBodySchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
  });
});
