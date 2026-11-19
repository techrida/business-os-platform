import { describe, expect, it } from 'vitest';

import { clearVerificationFiltersHref, readStatusFilter, statusParam } from './status-filter';

describe('readStatusFilter', () => {
  it('defaults to the cases awaiting review when the URL has no usable status', () => {
    const fallback = { status: ['submitted'], all: false, isDefault: true };
    expect(readStatusFilter(undefined)).toEqual(fallback);
    expect(readStatusFilter('nonsense')).toEqual(fallback);
    expect(readStatusFilter([])).toEqual(fallback);
  });

  it('keeps the statuses the URL names', () => {
    expect(readStatusFilter(['approved', 'rejected', 'approved'])).toEqual({
      status: ['approved', 'rejected'],
      all: false,
      isDefault: false,
    });
  });

  it('treats status=all as every status, distinct from no param', () => {
    expect(readStatusFilter('all')).toEqual({ status: [], all: true, isDefault: false });
  });

  it('lets a chosen status beat a leftover all from a no-JavaScript submit', () => {
    expect(readStatusFilter(['all', 'submitted'])).toEqual({
      status: ['submitted'],
      all: false,
      isDefault: false,
    });
  });
});

it('writes an empty selection as status=all', () => {
  expect(statusParam([])).toBe('all');
  expect(statusParam(['submitted'])).toEqual(['submitted']);
});

it('clears search and status to every case and keeps rows', () => {
  expect(
    clearVerificationFiltersHref({ q: 'acme', status: ['approved'], rows: '50', page: '3' }),
  ).toBe('/verification?status=all&rows=50');
  expect(clearVerificationFiltersHref({})).toBe('/verification?status=all');
});
