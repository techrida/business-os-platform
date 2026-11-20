import type { AdminTaxCode, TaxCodePeriod } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { addDays, firstEditableDay, isClosed, shownRate, statusText } from './tax-code-model';

const TODAY = '2026-11-20';

const period = (over: Partial<TaxCodePeriod>): TaxCodePeriod => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'VAT 13%',
  rate: '13',
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2025-07-17',
  effectiveTo: null,
  version: 1,
  ...over,
});

const code = (
  periods: TaxCodePeriod[],
  current: TaxCodePeriod | null,
  next: TaxCodePeriod | null,
): AdminTaxCode => ({
  code: 'VAT13',
  kind: 'vat',
  periods,
  current,
  next,
  endsOn: periods.at(-1)?.effectiveTo ?? null,
  latest: periods.at(-1)!,
});

describe('tax code model', () => {
  it('describes a code in use, one changing, one ending, one retired and one not started', () => {
    const open = period({});
    expect(statusText(code([open], open, null), TODAY)).toBe('In use');

    const closing = period({ effectiveTo: '2027-01-01' });
    const coming = period({ id: '2', rate: '15', effectiveFrom: '2027-01-01' });
    expect(statusText(code([closing, coming], closing, coming), TODAY)).toBe(
      'Changes to 15% on 2027-01-01',
    );

    const ending = period({ effectiveTo: '2026-12-01' });
    expect(statusText(code([ending], ending, null), TODAY)).toBe('Not offered from 2026-12-01');

    const retired = period({ effectiveTo: '2026-11-20' });
    expect(statusText(code([retired], null, null), TODAY)).toBe('Retired from 2026-11-20');
    expect(isClosed(code([retired], null, null))).toBe(true);

    const later = period({ effectiveFrom: '2026-12-15' });
    expect(statusText(code([later], null, later), TODAY)).toBe('Starts 2026-12-15');
    expect(shownRate(code([later], null, later))).toBe('13%');
  });

  it('never offers a change day before today or on the day the last period started', () => {
    expect(firstEditableDay(code([period({})], null, null), TODAY)).toBe(TODAY);
    expect(firstEditableDay(code([period({ effectiveFrom: TODAY })], null, null), TODAY)).toBe(
      '2026-11-21',
    );
    expect(
      firstEditableDay(code([period({ effectiveFrom: '2027-01-01' })], null, null), TODAY),
    ).toBe('2027-01-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
