import { describe, expect, it } from 'vitest';

import { dueRangeBounds } from './activities.types';

describe('dueRangeBounds', () => {
  it('starts at midnight in Kathmandu and ends before the midnight after the last day', () => {
    expect(dueRangeBounds({ dueFrom: '2030-01-01', dueTo: '2030-01-02' })).toEqual({
      from: new Date('2029-12-31T18:15:00.000Z'),
      before: new Date('2030-01-02T18:15:00.000Z'),
    });
  });

  it('covers one whole day when both ends are the same day', () => {
    const { from, before } = dueRangeBounds({ dueFrom: '2030-06-15', dueTo: '2030-06-15' });
    expect(before!.getTime() - from!.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('leaves an open end unbounded', () => {
    expect(dueRangeBounds({})).toEqual({});
    expect(dueRangeBounds({ dueTo: '2030-01-01' })).toEqual({
      before: new Date('2030-01-01T18:15:00.000Z'),
    });
  });
});
