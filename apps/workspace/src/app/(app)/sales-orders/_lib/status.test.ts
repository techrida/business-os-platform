import { SALES_ORDER_STATUSES, SCHEDULE_LINE_STATUSES, SCHEDULE_TRIGGERS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { readList } from '@/lib/list-params';

import { IDS, scheduleLine } from './fixtures';
import {
  evidenceKindLabel,
  heldInvoiceLabel,
  lineAction,
  SALES_ORDER_LIST_SPEC,
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
  const read = (params: Record<string, string | string[]>) =>
    readList(params, SALES_ORDER_LIST_SPEC);

  it('keeps every repeated contract status once, and drops anything else', () => {
    expect(read({ status: ['confirmed', 'draft', 'confirmed'] }).multi.status).toEqual([
      'confirmed',
      'draft',
    ]);
    expect(read({ status: 'confirmed' }).multi.status).toEqual(['confirmed']);
    expect(
      read({ status: ['', 'Confirmed', 'toString', 'paid', 'completed'] }).multi.status,
    ).toEqual(['completed']);
    expect(read({}).multi.status).toEqual([]);
  });

  it('keeps repeated customer ids that look like ids, and drops the rest', () => {
    expect(
      read({ customerId: [IDS.customer, 'x', `${IDS.customer}/../x`] }).multi.customerId,
    ).toEqual([IDS.customer]);
  });

  it('reads rows from the allowed sizes, else the default', () => {
    expect(read({ rows: '50' }).rows).toBe(50);
    expect(read({ rows: '7' }).rows).toBe(25);
    expect(read({}).rows).toBe(25);
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

// Audit #7: Sales reads its own orders but may not open invoices. A held invoice is named, not linked.
describe('a line that holds an invoice the person may not open', () => {
  const can = { mark: true, draft: true };
  const drafted = scheduleLine({
    id: IDS.advance,
    seq: 1,
    status: 'drafted',
    invoiceId: IDS.invoice,
    invoice: { number: null, status: 'draft' },
    can: { openInvoice: false },
  });

  it('names the invoice instead of linking to it, and without flags too', () => {
    expect(lineAction('confirmed', drafted, can)).toBe('show_invoice');
    const { can: _omitted, ...withoutFlags } = drafted;
    expect(lineAction('confirmed', withoutFlags, can)).toBe('show_invoice');
  });

  it('says the number and the status in one word', () => {
    expect(heldInvoiceLabel({ number: null, status: 'draft' })).toBe('Not numbered yet · Draft');
    expect(heldInvoiceLabel({ number: 'INV-2083/84-00007', status: 'submitted' })).toBe(
      'INV-2083/84-00007 · Submitted',
    );
    expect(heldInvoiceLabel(null)).toBeNull();
    expect(heldInvoiceLabel(undefined)).toBeNull();
  });
});
