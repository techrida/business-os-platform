import { INVOICE_KINDS, INVOICE_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  approvalWords,
  KIND_FILTER_OPTIONS,
  kindMeta,
  parseKindFilter,
  parseStatusFilter,
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

describe('filters from the URL', () => {
  it('accepts exactly one contract value', () => {
    expect(parseKindFilter('credit_note')).toBe('credit_note');
    expect(parseStatusFilter('issued')).toBe('issued');
  });

  it.each([
    undefined,
    '',
    'Issued',
    'ISSUED',
    'toString',
    '__proto__',
    'paid',
    ['issued', 'draft'],
  ])('turns %j into "no filter"', (raw) => {
    expect(parseStatusFilter(raw)).toBeUndefined();
    expect(parseKindFilter(raw)).toBeUndefined();
  });

  it('does not take a status as a kind or the other way round', () => {
    expect(parseKindFilter('issued')).toBeUndefined();
    expect(parseStatusFilter('tax_invoice')).toBeUndefined();
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
