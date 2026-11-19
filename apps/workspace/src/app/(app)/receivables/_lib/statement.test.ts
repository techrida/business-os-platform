import { describe, expect, it } from 'vitest';

import { settlementRow } from './fixtures';
import { daysText, statementFacts } from './statement';

describe('statement facts', () => {
  it('counts open and overdue items and finds the longest overdue, from server fields only', () => {
    const facts = statementFacts([
      settlementRow({ daysOverdue: 20 }),
      settlementRow({ invoiceId: '66666666-6666-4666-8666-666666666667', daysOverdue: 0 }),
      settlementRow({ invoiceId: '66666666-6666-4666-8666-666666666668', daysOverdue: 45 }),
    ]);
    expect(facts).toEqual({ open: 3, overdue: 2, longestOverdueDays: 45 });
  });

  it('is all zero for an empty statement', () => {
    expect(statementFacts([])).toEqual({ open: 0, overdue: 0, longestOverdueDays: 0 });
  });

  it('words a day count', () => {
    expect(daysText(1)).toBe('1 day');
    expect(daysText(45)).toBe('45 days');
  });
});
