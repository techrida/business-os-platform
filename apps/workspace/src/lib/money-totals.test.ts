// Unit tests: reading X-Money-Totals (D56 U15b-Q4). A missing or unreadable header is null, never a guess.
// Run with: pnpm --filter @bos/workspace exec vitest run src/lib/money-totals.test.ts
import { describe, expect, it } from 'vitest';

import { readMoneyTotals } from './money-totals';

const res = (headers: Record<string, string>) => new Response('[]', { headers });

describe('readMoneyTotals', () => {
  it('reads one total per currency as the server sent it', () => {
    expect(
      readMoneyTotals(
        res({
          'X-Money-Totals':
            '[{"currency":"NPR","amount":"2018180.00"},{"currency":"USD","amount":"25.00"}]',
        }),
      ),
    ).toEqual([
      { currency: 'NPR', amount: '2018180.00' },
      { currency: 'USD', amount: '25.00' },
    ]);
  });

  it.each([
    {},
    { 'X-Money-Totals': 'not json' },
    { 'X-Money-Totals': '[{"currency":"EUR","amount":"1.00"}]' },
    { 'X-Money-Totals': '[{"currency":"NPR","amount":"1.005"}]' },
  ])('answers null for %j', (headers) => {
    expect(readMoneyTotals(res(headers))).toBeNull();
  });
});
