import { SALES_ORDER_STATUSES, SCHEDULE_LINE_STATUSES, SCHEDULE_TRIGGERS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { IDS, scheduleLine } from './fixtures';
import {
  evidenceKindLabel,
  heldInvoiceLabel,
  lineAction,
  parseCustomerFilter,
  parseOrderStatusFilter,
  salesOrderStatusMeta,
  SALES_ORDER_FILTER_OPTIONS,
  scheduleLineStatusMeta,
  triggerLabel,
} from './status';

describe('status words', () => {
  it('has a label for every status, trigger and line status the contract names', () => {
    for (const s of SALES_ORDER_STATUSES) expect(salesOrderStatusMeta(s).label).not.toBe('');
    for (const s of SCHEDULE_LINE_STATUSES) expect(scheduleLineStatusMeta(s).label).not.toBe('');
    for (const t of SCHEDULE_TRIGGERS) expect(triggerLabel(t)).not.toBe('');
    expect(evidenceKindLabel('purchase_order')).toMatch(/purchase order/i);
    expect(SALES_ORDER_FILTER_OPTIONS.map((o) => o.value)).toEqual([...SALES_ORDER_STATUSES]);
  });
});

describe('filters read from the URL', () => {
  it('accepts exactly one contract status and nothing else', () => {
    expect(parseOrderStatusFilter('confirmed')).toBe('confirmed');
    for (const bad of [undefined, '', 'Confirmed', 'toString', ['confirmed'], 'paid']) {
      expect(parseOrderStatusFilter(bad as never)).toBeUndefined();
    }
  });

  it('accepts only a customer id that looks like one', () => {
    expect(parseCustomerFilter(IDS.customer)).toBe(IDS.customer);
    for (const bad of [undefined, '', 'x', [IDS.customer], `${IDS.customer}/../x`]) {
      expect(parseCustomerFilter(bad as never)).toBeUndefined();
    }
  });
});

describe('lineAction (what a schedule line offers)', () => {
  const can = { mark: true, draft: true };
  const planned = scheduleLine({ id: IDS.milestone, seq: 2, trigger: 'milestone' });

  it('offers Mark billable on a planned line that is not the advance', () => {
    expect(lineAction('confirmed', planned, can)).toBe('mark_billable');
    expect(lineAction('confirmed', { ...planned, trigger: 'advance' }, can)).toBe('none');
  });

  it('offers Draft invoice on a billable line', () => {
    expect(lineAction('confirmed', { ...planned, status: 'billable' }, can)).toBe('draft_invoice');
  });

  it('links to the invoice of a drafted or invoiced line, whatever the order status', () => {
    const drafted = {
      ...planned,
      status: 'drafted' as const,
      invoiceId: IDS.invoice,
      can: { openInvoice: true },
    };
    expect(lineAction('confirmed', drafted, can)).toBe('open_invoice');
    expect(lineAction('completed', { ...drafted, status: 'invoiced' }, can)).toBe('open_invoice');
  });

  it('offers nothing without the permission, or when the order is not confirmed', () => {
    expect(lineAction('confirmed', planned, { mark: false, draft: true })).toBe('none');
    expect(
      lineAction('confirmed', { ...planned, status: 'billable' }, { mark: true, draft: false }),
    ).toBe('none');
    expect(lineAction('draft', planned, can)).toBe('none');
    expect(lineAction('cancelled', { ...planned, status: 'billable' }, can)).toBe('none');
  });
});
