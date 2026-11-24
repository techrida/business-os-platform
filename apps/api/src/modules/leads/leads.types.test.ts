// Pure unit test of changedLeadFields: the expected-value comparison must stay linear on long zero runs.
import { describe, expect, it } from 'vitest';

import { changedLeadFields, type LeadRow } from './leads.types';

const row = (expectedValue: string): LeadRow => ({ expectedValue }) as LeadRow;

describe('changedLeadFields expectedValue', () => {
  it('reads 1000, 1000.0 and 1000.00 as one amount', () => {
    expect(changedLeadFields(row('1000.00'), { expectedValue: '1000' })).toEqual([]);
    expect(changedLeadFields(row('1000.00'), { expectedValue: '1000.0' })).toEqual([]);
    expect(changedLeadFields(row('1000.00'), { expectedValue: '1000.5' })).toHaveLength(1);
  });

  it('stays linear on a long run of zeros that does not end the string', () => {
    const hostile = `1.${'0'.repeat(200_000)}1`;
    const started = performance.now();
    expect(changedLeadFields(row('1.00'), { expectedValue: hostile })).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
