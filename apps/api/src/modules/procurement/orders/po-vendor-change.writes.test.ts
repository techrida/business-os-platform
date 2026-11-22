// sameApprovedTotal: a quotation replaces a draft without a new approval only when its total is the approved total
// and its NPR value is no higher (review finding: equal totals at a higher rate raised the approval band unapproved).
import { describe, expect, it } from 'vitest';

import { sameApprovedTotal } from './po-vendor-change.writes';

const po = { approvedTotal: '7400.00', approvedTotalNpr: '999000.00' };

describe('sameApprovedTotal', () => {
  it('takes an equal total at the same NPR value', () => {
    expect(sameApprovedTotal(po, { total: '7400.00', totalNpr: '999000.00' })).toBe(true);
  });

  it('takes an equal total at a lower NPR value', () => {
    expect(sameApprovedTotal(po, { total: '7400.00', totalNpr: '992600.00' })).toBe(true);
  });

  it('sends an equal total at a higher NPR value back for approval (USD 7,400.00 at 136 crosses NPR 1,000,000.00)', () => {
    expect(sameApprovedTotal(po, { total: '7400.00', totalNpr: '1006400.00' })).toBe(false);
  });

  it('sends a different total back for approval, up or down', () => {
    expect(sameApprovedTotal(po, { total: '7400.01', totalNpr: '999000.00' })).toBe(false);
    expect(sameApprovedTotal(po, { total: '7300.00', totalNpr: '985500.00' })).toBe(false);
  });
});
