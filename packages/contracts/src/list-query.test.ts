import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  FUZZY_THRESHOLD,
  MIN_SEARCH_LENGTH,
  MULTI_MAX,
  limitOffset,
  multi,
  pageWindow,
  searchParam,
} from './list-query.js';

const Status = z.enum(['new', 'contacted', 'won']);
const Query = z.strictObject({
  status: multi(Status),
  q: searchParam,
  ...limitOffset(),
});

describe('multi', () => {
  it('leaves a missing key out of the output', () => {
    expect(Query.parse({}).status).toBeUndefined();
  });

  it('accepts one string or an array, in order', () => {
    expect(Query.parse({ status: 'new' }).status).toEqual(['new']);
    expect(Query.parse({ status: ['won', 'new'] }).status).toEqual(['won', 'new']);
  });

  it('dedupes and drops empty values', () => {
    expect(Query.parse({ status: ['new', 'new', 'won', 'new'] }).status).toEqual(['new', 'won']);
    expect(Query.parse({ status: '' }).status).toEqual([]);
    expect(Query.parse({ status: ['', 'won'] }).status).toEqual(['won']);
  });

  it('refuses an unknown value and more than MULTI_MAX', () => {
    expect(Query.safeParse({ status: ['new', 'bogus'] }).success).toBe(false);
    const many = z.strictObject({ id: multi(z.string()) });
    const ids = Array.from({ length: MULTI_MAX + 1 }, (_, i) => `v${i}`);
    expect(many.safeParse({ id: ids }).success).toBe(false);
    expect(many.safeParse({ id: ids.slice(0, MULTI_MAX) }).success).toBe(true);
  });

  it('still refuses unknown params in a strict object', () => {
    expect(Query.safeParse({ nope: '1' }).success).toBe(false);
  });

  it('infers an optional key', () => {
    type Out = z.infer<typeof Query>;
    expectTypeOf<Out['status']>().toEqualTypeOf<('new' | 'contacted' | 'won')[] | undefined>();
    const ok: Pick<Out, 'limit' | 'offset'> = { limit: 1, offset: 0 };
    expect(ok.limit).toBe(1);
    // The key itself is optional: this assignment would not compile with a required key.
    const partial: Omit<Out, 'limit' | 'offset' | 'q'> = {};
    expect(partial).toEqual({});
  });
});

describe('searchParam', () => {
  it('trims and keeps a search of MIN_SEARCH_LENGTH or more', () => {
    expect(MIN_SEARCH_LENGTH).toBe(2);
    expect(Query.parse({ q: '  ab ' }).q).toBe('ab');
  });

  it('treats blank and one-character searches as no search', () => {
    expect(Query.parse({ q: '' }).q).toBeUndefined();
    expect(Query.parse({ q: '   ' }).q).toBeUndefined();
    expect(Query.parse({ q: 'a' }).q).toBeUndefined();
  });

  it('refuses a repeated q and an over-long one', () => {
    expect(Query.safeParse({ q: ['a', 'b'] }).success).toBe(false);
    expect(Query.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('limitOffset', () => {
  it('coerces text and applies defaults', () => {
    expect(Query.parse({})).toMatchObject({ limit: 25, offset: 0 });
    expect(Query.parse({ limit: '50', offset: '100' })).toMatchObject({ limit: 50, offset: 100 });
  });

  it('refuses limit 0, above the cap and a negative offset', () => {
    expect(Query.safeParse({ limit: '0' }).success).toBe(false);
    expect(Query.safeParse({ limit: '101' }).success).toBe(false);
    expect(Query.safeParse({ offset: '-1' }).success).toBe(false);
  });
});

describe('pageWindow', () => {
  it('turns page and rows into limit and offset', () => {
    expect(pageWindow(1, 25)).toMatchObject({ limit: 25, offset: 0 });
    expect(pageWindow(3, 25)).toMatchObject({ limit: 25, offset: 50 });
  });

  it('clamps to the last page once the total is known', () => {
    expect(pageWindow(9, 25, 60)).toEqual({
      page: 3,
      pageCount: 3,
      limit: 25,
      offset: 50,
      first: 51,
      last: 60,
    });
  });

  it('has one empty page when there are no rows', () => {
    expect(pageWindow(4, 25, 0)).toEqual({
      page: 1,
      pageCount: 1,
      limit: 25,
      offset: 0,
      first: 0,
      last: 0,
    });
  });

  it('treats a bad page as page 1', () => {
    expect(pageWindow(Number.NaN, 10).page).toBe(1);
    expect(pageWindow(0, 10).page).toBe(1);
    expect(pageWindow(-3, 10, 5).page).toBe(1);
  });
});

describe('FUZZY_THRESHOLD', () => {
  it('is 5', () => {
    expect(FUZZY_THRESHOLD).toBe(5);
  });
});
