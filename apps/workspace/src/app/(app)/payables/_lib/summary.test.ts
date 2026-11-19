import { describe, expect, it, vi } from 'vitest';

import { BILL_COUNT_CARDS, PAYMENT_REQUEST_COUNT_CARDS, countCards } from './summary';

describe('countCards', () => {
  it('reads one total per card with that card’s statuses, in card order', async () => {
    const total = vi.fn((statuses: readonly string[]) =>
      Promise.resolve(statuses.length === 0 ? 40 : statuses.length),
    );
    const cards = await countCards(BILL_COUNT_CARDS, total);
    expect(total.mock.calls.map(([s]) => s)).toEqual([
      [],
      ['variance', 'exception_pending'],
      ['pending_approval'],
      ['approved', 'partially_paid'],
      ['paid'],
    ]);
    expect(cards?.map((c) => [c.label, c.value])).toEqual([
      ['All bills', 40],
      ['Outside tolerance', 2],
      ['Awaiting approval', 1],
      ['Approved to pay', 2],
      ['Paid', 1],
    ]);
    expect(cards?.[0]).not.toHaveProperty('statuses');
  });

  it('leaves the cards out when any read fails, rather than showing a false zero', async () => {
    const total = vi.fn((statuses: readonly string[]) =>
      statuses.includes('rejected') ? Promise.reject(new Error('403')) : Promise.resolve(3),
    );
    expect(await countCards(PAYMENT_REQUEST_COUNT_CARDS, total)).toBeNull();
    expect(total).toHaveBeenCalledTimes(PAYMENT_REQUEST_COUNT_CARDS.length);
  });
});
