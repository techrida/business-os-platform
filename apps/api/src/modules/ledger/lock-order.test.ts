import { describe, expect, it } from 'vitest';

import { LOCK_RANKS, LockOrderError, planLocks, sortedIds } from './lock-order';

describe('LOCK_RANKS', () => {
  it('follows the plan: SO, schedule lines, payment, invoices and open items, number_series last', () => {
    expect(LOCK_RANKS).toEqual([
      'sales_order',
      'schedule_line',
      'payment',
      'invoice',
      'open_item',
      'number_series',
    ]);
  });
});

describe('sortedIds', () => {
  it('sorts ascending and drops duplicates', () => {
    expect(sortedIds(['c', 'a', 'b', 'a'])).toEqual(['a', 'b', 'c']);
  });

  it('sorts uuids the way Postgres orders the uuid type (bytewise, lowercase hex)', () => {
    const ids = ['F0000000-0000-4000-8000-000000000000', '0a000000-0000-4000-8000-000000000000'];
    expect(sortedIds(ids)).toEqual([
      '0a000000-0000-4000-8000-000000000000',
      'f0000000-0000-4000-8000-000000000000',
    ]);
  });
});

describe('planLocks', () => {
  it('keeps steps in rank order and sorts the ids of each', () => {
    expect(
      planLocks([
        { rank: 'payment', ids: ['p2', 'p1'] },
        { rank: 'open_item', ids: ['o3', 'o1', 'o3'] },
      ]),
    ).toEqual([
      { rank: 'payment', ids: ['p1', 'p2'] },
      { rank: 'open_item', ids: ['o1', 'o3'] },
    ]);
  });

  it('drops a step with no ids', () => {
    expect(
      planLocks([
        { rank: 'payment', ids: [] },
        { rank: 'open_item', ids: ['o1'] },
      ]),
    ).toEqual([{ rank: 'open_item', ids: ['o1'] }]);
  });

  it('refuses a step out of order (a deadlock waiting to happen)', () => {
    expect(() =>
      planLocks([
        { rank: 'open_item', ids: ['o1'] },
        { rank: 'payment', ids: ['p1'] },
      ]),
    ).toThrow(LockOrderError);
  });

  it('refuses the same rank twice (its ids must be locked in one ascending pass)', () => {
    expect(() =>
      planLocks([
        { rank: 'open_item', ids: ['o2'] },
        { rank: 'open_item', ids: ['o1'] },
      ]),
    ).toThrow(LockOrderError);
  });

  it('refuses number_series: NumberingService.issue takes that lock itself, last', () => {
    expect(() => planLocks([{ rank: 'number_series', ids: ['n1'] }])).toThrow(LockOrderError);
  });
});
