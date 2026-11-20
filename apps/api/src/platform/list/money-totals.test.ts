// Unit tests: the X-Money-Totals header and the per-currency sums behind it (D56 U15b-Q4).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/list/money-totals.test.ts
import { MoneyTotalsSchema } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { setMoneyTotals, sumByCurrency } from './money-totals';

describe('sumByCurrency', () => {
  it('counts every group, keeps one total per currency in NPR, INR, USD order and writes 2 decimals', () => {
    const { total, totals } = sumByCurrency([
      { currency: 'USD', n: 2, amount: '10.5' },
      { currency: 'NPR', n: 3, amount: '2018180.00' },
      { currency: 'INR', n: 1, amount: '7' },
    ]);
    expect(total).toBe(6);
    expect(totals).toEqual([
      { currency: 'NPR', amount: '2018180.00' },
      { currency: 'INR', amount: '7.00' },
      { currency: 'USD', amount: '10.50' },
    ]);
    expect(MoneyTotalsSchema.parse(totals)).toEqual(totals);
  });

  it('answers 0 and no totals when nothing matches', () => {
    expect(sumByCurrency([])).toEqual({ total: 0, totals: [] });
  });
});

describe('setMoneyTotals', () => {
  it('sends the totals as JSON in X-Money-Totals', () => {
    const res = { setHeader: vi.fn() };
    setMoneyTotals(res, [{ currency: 'NPR', amount: '150.00' }]);
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Money-Totals',
      '[{"currency":"NPR","amount":"150.00"}]',
    );
  });
});
