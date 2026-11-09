import { SETTLEMENT_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { SETTLEMENT_OPTIONS, settlementMeta } from './settlement';

describe('settlement status', () => {
  it('has a label and a tone for every contract status, in contract order', () => {
    expect(SETTLEMENT_OPTIONS.map((o) => o.value)).toEqual([...SETTLEMENT_STATUSES]);
    for (const s of SETTLEMENT_STATUSES) {
      expect(settlementMeta(s).label).not.toBe('');
      expect(settlementMeta(s).tone).toBeTruthy();
    }
  });

  it('words each status the way Finance says it', () => {
    expect(settlementMeta('unpaid').label).toBe('Unpaid');
    expect(settlementMeta('partly_paid').label).toBe('Partly paid');
    expect(settlementMeta('paid').label).toBe('Paid');
    expect(settlementMeta('overdue').label).toBe('Overdue');
    expect(settlementMeta('credited').label).toBe('Credited');
  });

  it('makes overdue stand out from the other open states', () => {
    expect(settlementMeta('overdue').tone).toBe('error');
    expect(settlementMeta('paid').tone).toBe('success');
    expect(settlementMeta('partly_paid').tone).toBe('warning');
  });
});
