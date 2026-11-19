import { describe, expect, it, vi } from 'vitest';

import { PO_SUMMARY, RFQ_SUMMARY, summaryCards } from './summary';

describe('summaryCards', () => {
  it('reads one RFQ total per card, all statuses first, and keeps the order', async () => {
    const totals: Record<string, number> = { '': 9, open: 4, closed: 2, recommended: 3 };
    const read = vi.fn((status: string[]) =>
      Promise.resolve({ total: totals[status.join()] ?? -1 }),
    );
    const cards = await summaryCards(RFQ_SUMMARY, read);
    expect(read.mock.calls.map(([status]) => status)).toEqual([
      [],
      ['open'],
      ['closed'],
      ['recommended'],
    ]);
    expect(cards?.map((c) => [c.label, c.value])).toEqual([
      ['Total RFQs', 9],
      ['Open for quotations', 4],
      ['Waiting for a recommendation', 2],
      ['Recommended', 3],
    ]);
  });

  it('counts issued and partly received orders together as waiting for delivery', async () => {
    const read = vi.fn((status: string[]) => Promise.resolve({ total: status.length }));
    const cards = await summaryCards(PO_SUMMARY, read);
    expect(read.mock.calls.map(([status]) => status)).toEqual([
      [],
      ['draft'],
      ['issued', 'partially_received'],
      ['amendment_pending'],
    ]);
    expect(cards?.find((c) => c.key === 'receiving')).toMatchObject({
      label: 'Waiting for delivery',
      value: 2,
    });
  });

  it('leaves every card out when any read fails', async () => {
    const read = vi.fn((status: string[]) =>
      status[0] === 'closed' ? Promise.reject(new Error('down')) : Promise.resolve({ total: 1 }),
    );
    expect(await summaryCards(RFQ_SUMMARY, read)).toBeNull();
  });
});
