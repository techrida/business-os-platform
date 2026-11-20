// The X-Money-Totals header (D56 U15b-Q4): a list endpoint that shows money also says what its money column adds
// up to over every match, one total per currency (never summed across currencies). Set beside X-Total-Count:
//
//   const { rows, total, totals } = await this.payments.list(scope, query);
//   setTotalCount(res, total);
//   setMoneyTotals(res, totals);
//
// The totals come from the list's own `count` callback (see `sumByCurrency`), so they describe exactly the rows
// the count describes, including searchPage's choice between exact and close matches.
import { CURRENCIES, type Currency, MONEY_TOTALS_HEADER, type MoneyTotals } from '@bos/contracts';
import Decimal from 'decimal.js';

import type { HeaderTarget } from './total-count';

export function setMoneyTotals(res: HeaderTarget, totals: MoneyTotals): void {
  res.setHeader(MONEY_TOTALS_HEADER, JSON.stringify(totals));
}

/**
 * Per-currency groups (`{ currency, n, amount }`, as a GROUP BY currency count returns them) as the row count and
 * the totals: amounts to 2 decimals, in the fixed currency order (NPR first).
 */
export function sumByCurrency(
  groups: readonly { currency: Currency; n: number; amount: string | null }[],
): { total: number; totals: MoneyTotals } {
  const order = (c: Currency) => CURRENCIES.indexOf(c);
  return {
    total: groups.reduce((sum, g) => sum + Number(g.n), 0),
    totals: [...groups]
      .sort((a, b) => order(a.currency) - order(b.currency))
      .map((g) => ({
        currency: g.currency,
        amount: new Decimal(g.amount ?? '0').toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      })),
  };
}
