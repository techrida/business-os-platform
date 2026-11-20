// Unit tests of ReviseService's pure helpers: the validity date arithmetic and the pricing input built from a
// stored version (its numeric(18,4) discount trimmed back to the contract's form). The database steps of revise
// are in revise.integration.test.ts.
import { describe, expect, it } from 'vitest';

import type { QuotationLineRow } from './mapping';
import { addDays, revisedPricingInput, revisedValidUntil } from './revise.service';

const line = (lineNo: number, overrides: Partial<QuotationLineRow> = {}): QuotationLineRow =>
  ({
    id: `line-${lineNo}`,
    lineNo,
    catalogItemId: null,
    description: `Line ${lineNo}`,
    uom: 'lot',
    quantity: '1.0000',
    unitPrice: '100.00',
    unitCost: null,
    taxCodeId: 'tax-1',
    gross: '100.00',
    discountAlloc: '0.00',
    taxable: '100.00',
    ...overrides,
  }) as QuotationLineRow;

describe('addDays', () => {
  it('adds calendar days across a month and a year end', () => {
    expect(addDays('2026-11-21', 15)).toBe('2026-12-06');
    expect(addDays('2026-12-25', 15)).toBe('2027-01-09');
    expect(addDays('2028-02-20', 10)).toBe('2028-03-01');
  });
});

describe('revisedValidUntil (TR-Q12g)', () => {
  it('keeps a previous date that has not passed on the new issue date, the issue day itself included', () => {
    expect(revisedValidUntil('2026-12-09', '2026-11-21', 15)).toBe('2026-12-09');
    expect(revisedValidUntil('2026-11-21', '2026-11-21', 15)).toBe('2026-11-21');
  });

  it('gives the issue date plus the configured days once the previous date has passed', () => {
    expect(revisedValidUntil('2026-11-20', '2026-11-21', 15)).toBe('2026-12-06');
    expect(revisedValidUntil('2025-01-01', '2026-11-21', 30)).toBe('2026-12-21');
  });
});

describe('revisedPricingInput', () => {
  it('copies the lines in line order at the new issue date', () => {
    const input = revisedPricingInput(
      { currency: 'NPR', discountMode: null, discountInput: null },
      [line(2, { unitCost: '40.00' }), line(1)],
      '2026-11-21',
    );
    expect(input).toEqual({
      currency: 'NPR',
      issueDate: '2026-11-21',
      discount: null,
      lines: [
        expect.objectContaining({ lineNo: 1, description: 'Line 1', unitCost: null }),
        expect.objectContaining({ lineNo: 2, description: 'Line 2', unitCost: '40.00' }),
      ],
    });
  });

  it('trims a stored discount to the form the client sends', () => {
    expect(
      revisedPricingInput(
        { currency: 'USD', discountMode: 'pct', discountInput: '8.0000' },
        [line(1)],
        '2026-11-21',
      ).discount,
    ).toEqual({ mode: 'pct', value: '8' });
    expect(
      revisedPricingInput(
        { currency: 'NPR', discountMode: 'amount', discountInput: '208000.5000' },
        [line(1)],
        '2026-11-21',
      ).discount,
    ).toEqual({ mode: 'amount', value: '208000.50' });
  });
});
