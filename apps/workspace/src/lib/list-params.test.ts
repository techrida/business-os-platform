import { describe, expect, it } from 'vitest';

import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from './list-params';

const spec = {
  multi: { status: ['new', 'contacted', 'won'], owner: /^[a-z]+$/ },
  single: { from: /^\d{4}-\d{2}-\d{2}$/ },
  rows: { allowed: [10, 25, 50], default: 25 },
} as const;

describe('readList', () => {
  it('reads repeated and single values, dedupes and drops unknown ones', () => {
    const state = readList(
      { status: ['new', 'bogus', 'new', 'won'], owner: 'ana', from: '2026-01-02' },
      spec,
    );
    expect(state.multi.status).toEqual(['new', 'won']);
    expect(state.multi.owner).toEqual(['ana']);
    expect(state.single.from).toBe('2026-01-02');
  });

  it('gives empty arrays and undefined for missing params', () => {
    const state = readList({}, spec);
    expect(state).toMatchObject({ q: undefined, page: 1, rows: 25 });
    expect(state.multi.status).toEqual([]);
    expect(state.single.from).toBeUndefined();
  });

  it('takes the first valid value of a single param', () => {
    expect(readList({ from: ['nope', '2026-02-03', '2026-03-04'] }, spec).single.from).toBe(
      '2026-02-03',
    );
  });

  it('caps multi values at 20', () => {
    const owners = Array.from({ length: 30 }, (_, i) => `${'a'.repeat(i + 1)}`);
    expect(readList({ owner: owners }, spec).multi.owner).toHaveLength(20);
  });

  it('trims q, caps it at 100 and drops it under 2 characters', () => {
    expect(readList({ q: '  acme  ' }, spec).q).toBe('acme');
    expect(readList({ q: ' a ' }, spec).q).toBeUndefined();
    expect(readList({ q: 'x'.repeat(150) }, spec).q).toHaveLength(100);
    expect(readList({ q: ['ab', 'cd'] }, spec).q).toBe('ab');
  });

  it('honours a custom or disabled search param', () => {
    expect(readList({ search: 'acme' }, { search: 'search' }).q).toBe('acme');
    expect(readList({ q: 'acme' }, { search: false }).q).toBeUndefined();
  });

  it('keeps page at 1 or more and ignores junk', () => {
    expect(readList({ page: '3' }, spec).page).toBe(3);
    for (const bad of ['0', '-2', 'x', '1.5', '', '9999999999']) {
      expect(readList({ page: bad }, spec).page).toBe(1);
    }
  });

  it('accepts rows only from the allow-list', () => {
    expect(readList({ rows: '50' }, spec).rows).toBe(50);
    expect(readList({ rows: '51' }, spec).rows).toBe(25);
    expect(readList({ rows: 'many' }, spec).rows).toBe(25);
  });
});

describe('hrefWith', () => {
  it('repeats the key for arrays and keeps untouched params in place', () => {
    expect(hrefWith('/leads', { view: 'board', status: 'new' }, { status: ['won', 'new'] })).toBe(
      '/leads?view=board&status=won&status=new',
    );
  });

  it('removes a key for empty values', () => {
    const current = { status: ['a', 'b'], q: 'acme', owner: 'ana' };
    expect(hrefWith('/leads', current, { status: [], q: '', owner: undefined })).toBe('/leads');
  });

  it('drops page unless the patch sets it', () => {
    expect(hrefWith('/leads', { page: '4', status: 'new' }, { status: 'won' })).toBe(
      '/leads?status=won',
    );
    expect(hrefWith('/leads', { page: '4' }, { page: 5 })).toBe('/leads?page=5');
    expect(hrefWith('/leads', { page: '4' }, {})).toBe('/leads');
  });

  it('works from URLSearchParams and encodes values', () => {
    const current = new URLSearchParams('rows=50&q=a+b');
    expect(hrefWith('/leads', current, { owner: 'ana & bo' })).toBe(
      '/leads?rows=50&q=a+b&owner=ana+%26+bo',
    );
  });

  it('ignores empty values already in the URL', () => {
    expect(hrefWith('/x', { q: '', rows: '25' }, {})).toBe('/x?rows=25');
  });
});

describe('clearFiltersHref', () => {
  it('removes filters, search and page but keeps rows and view', () => {
    const current = {
      q: 'acme',
      status: ['new'],
      from: '2026-01-01',
      page: '2',
      rows: '50',
      view: 'board',
    };
    expect(clearFiltersHref('/leads', current, spec)).toBe('/leads?rows=50&view=board');
  });
});

describe('activeFilterLabels', () => {
  it('names each filter that hides rows, with display text for values', () => {
    const state = readList({ q: 'acme', status: ['new', 'won'], from: '2026-01-02' }, spec);
    expect(
      activeFilterLabels(state, {
        status: { label: 'Status', format: (value) => value.toUpperCase() },
        from: { label: 'From' },
      }),
    ).toEqual(['Search “acme”', 'Status: NEW, WON', 'From: 2026-01-02']);
  });

  it('is empty when nothing is filtered', () => {
    expect(activeFilterLabels(readList({}, spec))).toEqual([]);
  });
});
