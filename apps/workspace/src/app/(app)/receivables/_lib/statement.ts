// The facts above a customer statement, read from the rows the server sent. Counts only: no amount
// is added up here, because open money is summed on the server or not at all (currencies differ).
import type { InvoiceSettlement } from '@bos/contracts';

export interface StatementFacts {
  /** Open items on the statement. */
  open: number;
  /** Items past their due date, by the server's own `daysOverdue`. */
  overdue: number;
  /** The most days any item is overdue, or 0 when none is. */
  longestOverdueDays: number;
}

export function statementFacts(items: readonly InvoiceSettlement[]): StatementFacts {
  let overdue = 0;
  let longestOverdueDays = 0;
  for (const item of items) {
    if (item.daysOverdue > 0) overdue += 1;
    longestOverdueDays = Math.max(longestOverdueDays, item.daysOverdue);
  }
  return { open: items.length, overdue, longestOverdueDays };
}

export function daysText(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
