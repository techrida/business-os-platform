// The customer view of a sales order's billing schedule (F1-Q34), as pure functions: the status words, the cancelled
// line left out, an invoice named only when the portal invoice filter let it through, and the strict schema refusing
// any field the whitelist does not name.
import { PortalSalesOrderSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { toPortalMilestoneStatus, toPortalSalesOrder } from './portal-milestones.service';

const ORDER = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';
const order = {
  id: ORDER,
  number: 'SO-2083/84-00001',
  status: 'confirmed' as const,
  confirmedAt: new Date('2026-11-02T04:00:00Z'),
  currency: 'NPR' as const,
  total: '1130.00',
};
const line = (over: Partial<Parameters<typeof toPortalSalesOrder>[1][number]> = {}) => ({
  salesOrderId: ORDER,
  seq: 1,
  label: 'Advance 40%',
  percent: '40.0000',
  amount: '452.00',
  plannedDate: null,
  status: 'invoiced' as const,
  invoiceId: INVOICE,
  ...over,
});

describe('toPortalMilestoneStatus', () => {
  it.each([
    ['planned', 'upcoming'],
    ['billable', 'reached'],
    ['drafted', 'reached'],
    ['invoiced', 'invoiced'],
  ] as const)('reads %s as %s', (status, word) => {
    expect(toPortalMilestoneStatus(status)).toBe(word);
  });
});

describe('toPortalSalesOrder', () => {
  it('names the invoice only when the portal shows it, and trims the percent', () => {
    const shown = toPortalSalesOrder(
      order,
      [line()],
      new Map([[INVOICE, { id: INVOICE, number: 'INV-1', dueDate: '2026-12-03' }]]),
    );
    expect(shown.milestones[0]).toMatchObject({
      percent: '40',
      status: 'invoiced',
      invoice: { id: INVOICE, number: 'INV-1', dueDate: '2026-12-03' },
    });
    expect(toPortalSalesOrder(order, [line()], new Map()).milestones[0]?.invoice).toBeNull();
  });

  it('leaves out cancelled lines and lines of other orders, in schedule order', () => {
    const view = toPortalSalesOrder(
      order,
      [
        line({ seq: 3, label: 'Final', status: 'planned', invoiceId: null }),
        line({ seq: 2, label: 'Gone', status: 'cancelled', invoiceId: null }),
        line({ seq: 1, label: 'Other', salesOrderId: INVOICE, status: 'planned', invoiceId: null }),
      ],
      new Map(),
    );
    expect(view.milestones.map((m) => m.label)).toEqual(['Final']);
  });

  it('is a strict whitelist: a staff field is refused', () => {
    const view = toPortalSalesOrder(order, [], new Map());
    expect(() => PortalSalesOrderSchema.parse({ ...view, amountNpr: '1130.00' })).toThrow();
  });
});
