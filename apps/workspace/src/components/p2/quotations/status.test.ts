import { QUOTATION_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { parseStatusFilter, quotationStatusMeta, STATUS_FILTER_OPTIONS } from './status';

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

describe('parseStatusFilter', () => {
  it('accepts exactly the contract statuses', () => {
    for (const status of QUOTATION_STATUSES) {
      expect(parseStatusFilter(status)).toBe(status);
    }
  });

  it('treats absent, empty, unknown and repeated values as no filter', () => {
    expect(parseStatusFilter(undefined)).toBeUndefined();
    expect(parseStatusFilter('')).toBeUndefined();
    expect(parseStatusFilter('all')).toBeUndefined();
    expect(parseStatusFilter('Draft')).toBeUndefined();
    expect(parseStatusFilter('draft ')).toBeUndefined();
    expect(parseStatusFilter('draft&status=sent')).toBeUndefined();
    expect(parseStatusFilter(['draft', 'sent'])).toBeUndefined();
    expect(parseStatusFilter('__proto__')).toBeUndefined();
    expect(parseStatusFilter('toString')).toBeUndefined();
  });
});

describe('STATUS_FILTER_OPTIONS', () => {
  it('lists every status once, in the contract order', () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([...QUOTATION_STATUSES]);
  });
});
