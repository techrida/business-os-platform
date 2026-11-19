import { QUOTATION_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { clearFiltersHref, readList } from '@/lib/list-params';

import {
  QUOTATION_FILTER_SPEC,
  QUOTATION_LIST_SPEC,
  quotationStatusMeta,
  STATUS_FILTER_OPTIONS,
} from './status';

describe('quotationStatusMeta', () => {
  it('has a plain label and a tone for every status the contract knows', () => {
    for (const status of QUOTATION_STATUSES) {
      const meta = quotationStatusMeta(status);
      expect(meta.label.length, status).toBeGreaterThan(0);
      expect(['neutral', 'info', 'success', 'warning', 'error'], status).toContain(meta.tone);
    }
  });

  it('gives every status its own label, so two never read the same in a list', () => {
    const labels = QUOTATION_STATUSES.map((s) => quotationStatusMeta(s).label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('colours the outcomes: accepted is success, rejected is error, submitted is pending', () => {
    expect(quotationStatusMeta('accepted').tone).toBe('success');
    expect(quotationStatusMeta('rejected').tone).toBe('error');
    expect(quotationStatusMeta('submitted').tone).toBe('warning');
  });
});

describe('QUOTATION_LIST_SPEC', () => {
  const OPP = '11111111-1111-4111-8111-111111111111';

  it('keeps every repeated contract status once, in order', () => {
    const state = readList({ status: ['draft', 'sent', 'draft'] }, QUOTATION_LIST_SPEC);
    expect(state.multi.status).toEqual(['draft', 'sent']);
  });

  it('keeps a single status and drops values that are not contract statuses', () => {
    for (const status of QUOTATION_STATUSES) {
      expect(readList({ status }, QUOTATION_LIST_SPEC).multi.status).toEqual([status]);
    }
    for (const bad of [
      '',
      'all',
      'Draft',
      'draft ',
      'draft&status=sent',
      '__proto__',
      'toString',
    ]) {
      expect(readList({ status: bad }, QUOTATION_LIST_SPEC).multi.status, bad).toEqual([]);
    }
    expect(readList({ status: ['nonsense', 'sent'] }, QUOTATION_LIST_SPEC).multi.status).toEqual([
      'sent',
    ]);
  });

  it('reads customers as ids and the opportunity as one id', () => {
    const state = readList(
      { customerId: [OPP, 'x'], opportunityId: ['../x', OPP] },
      QUOTATION_LIST_SPEC,
    );
    expect(state.multi.customerId).toEqual([OPP]);
    expect(state.single.opportunityId).toBe(OPP);
    expect(readList({ opportunityId: '../x' }, QUOTATION_LIST_SPEC).single.opportunityId).toBe(
      undefined,
    );
  });

  it('keeps the opportunity scope when filters are cleared', () => {
    const href = clearFiltersHref(
      '/quotations',
      { q: 'himal', status: ['draft', 'sent'], opportunityId: OPP, rows: '10', page: '2' },
      QUOTATION_FILTER_SPEC,
    );
    expect(href).toBe(`/quotations?opportunityId=${OPP}&rows=10`);
  });
});

describe('STATUS_FILTER_OPTIONS', () => {
  it('lists every status once, in the contract order', () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([...QUOTATION_STATUSES]);
  });
});
