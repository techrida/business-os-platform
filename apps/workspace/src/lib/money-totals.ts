// Reads X-Money-Totals (D56 U15b-Q4): a list endpoint's money column summed over all matches, one total per
// currency. The figures are the server's strings; nothing here adds them. A missing or unreadable header gives
// null, so the page leaves its total row out rather than show a wrong sum.
import { MONEY_TOTALS_HEADER, type MoneyTotals, MoneyTotalsSchema } from '@bos/contracts';

export function readMoneyTotals(res: Pick<Response, 'headers'>): MoneyTotals | null {
  const header = res.headers.get(MONEY_TOTALS_HEADER);
  if (header === null) return null;
  try {
    const parsed = MoneyTotalsSchema.safeParse(JSON.parse(header));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
