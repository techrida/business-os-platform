import { INVOICE_KINDS, INVOICE_STATUSES, SETTLEMENT_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  approvalWords,
  KIND_FILTER_OPTIONS,
  kindMeta,
  SETTLEMENT_FILTER_OPTIONS,
  settlementLabel,
  STATUS_FILTER_OPTIONS,
  statusMeta,
} from './meta';

describe('labels', () => {
  it('has a label and a tone for every kind and status in the contract', () => {
    for (const k of INVOICE_KINDS) expect(kindMeta(k).label.length).toBeGreaterThan(0);
    for (const s of INVOICE_STATUSES) expect(statusMeta(s).label.length).toBeGreaterThan(0);
    expect(KIND_FILTER_OPTIONS.map((o) => o.value)).toEqual([...INVOICE_KINDS]);
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([...INVOICE_STATUSES]);
  });

  it('says "Awaiting approval" for a submitted invoice and never invents a payment status', () => {
    expect(statusMeta('submitted').label).toBe('Awaiting approval');
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).not.toContain('paid');
  });
});

describe('settlement filter', () => {
  it('words every derived state and keeps paid and overdue out of the status list', () => {
    expect(SETTLEMENT_FILTER_OPTIONS.map((o) => o.value)).toEqual([...SETTLEMENT_STATUSES]);
    expect(settlementLabel('overdue')).toBe('Overdue');
    expect(settlementLabel('partly_paid')).toBe('Partly paid');
    const statuses: string[] = STATUS_FILTER_OPTIONS.map((o) => o.value);
    expect(statuses).not.toContain('overdue');
    expect(statuses).not.toContain('paid');
  });

  it('shows a value from a newer API as it came, never an object key', () => {
    expect(settlementLabel('disputed')).toBe('disputed');
    expect(settlementLabel('toString')).toBe('toString');
  });
});

describe('approvalWords', () => {
  it('says a proforma needs no approval', () => {
    expect(approvalWords('proforma', 'draft')).toMatch(/no approval/i);
    expect(approvalWords('proforma', 'issued')).toMatch(/no approval/i);
  });

  it.each([
    ['draft', /not submitted/i],
    ['submitted', /awaiting/i],
    ['returned', /returned/i],
    ['approved', /approved/i],
  ] as const)('reads %s for a tax invoice', (status, expected) => {
    expect(approvalWords('tax_invoice', status)).toMatch(expected);
  });
});
