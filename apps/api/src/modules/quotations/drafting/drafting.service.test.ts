// Unit tests of the PUT merge rule; the database path is covered by drafting.integration.test.ts.
import { describe, expect, it } from 'vitest';

import { mergeDraftPatch } from './drafting.service';

const saved = {
  currency: 'NPR',
  scope: 'Phase 1 and 2',
  contactId: '11111111-1111-4111-8111-111111111111',
  discount: { mode: 'pct', value: '8' },
  paymentSchedule: [{ label: 'All', percent: '100' }],
};

describe('mergeDraftPatch', () => {
  it('keeps every saved value the patch leaves out', () => {
    expect(mergeDraftPatch(saved, { scope: 'Phase 1 only' })).toEqual({
      ...saved,
      scope: 'Phase 1 only',
    });
  });

  it('clears a saved value the patch sets to null', () => {
    const merged = mergeDraftPatch(saved, { discount: null, contactId: null, scope: undefined });
    expect(merged).not.toHaveProperty('discount');
    expect(merged).not.toHaveProperty('contactId');
    expect(merged.scope).toBe('Phase 1 and 2');
  });

  it('replaces the schedule with an empty one', () => {
    expect(mergeDraftPatch(saved, { paymentSchedule: [] }).paymentSchedule).toEqual([]);
  });
});
