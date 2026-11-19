// Pure tests of the search helper: a fake handle records what runs, so the decision (exact, fuzzy, which
// queries carry the scope) is checked without a database. The real-Postgres proof is search-page.integration.test.ts.
import { PgDialect, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { eq, sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { type Reader, type PageQuery, escapeLike, searchPage } from './search-page';

const t = pgTable('things', { id: uuid('id'), name: text('name'), city: text('city') });
const dialect = new PgDialect();
const render = (s: SQL | undefined) => (s === undefined ? '' : dialect.sqlToQuery(s).sql);
const params = (s: SQL | undefined) => (s === undefined ? [] : dialect.sqlToQuery(s).params);

interface Calls {
  counts: (string | undefined)[];
  countParams: unknown[][];
  pages: { where: string; order: string[]; limit: number; offset: number }[];
  executed: string[];
  transactions: number;
}

/** `totals` answers count() in order; the fake tx is distinguishable from the pool by `inTx`. */
function setup(totals: number[]) {
  const calls: Calls = { counts: [], countParams: [], pages: [], executed: [], transactions: 0 };
  const where = (x: SQL | undefined) => render(x);
  const handle = (inTx: boolean) => ({
    inTx,
    execute: (q: SQL) => {
      calls.executed.push(render(q));
      return Promise.resolve([]);
    },
    transaction: <T>(fn: (tx: unknown) => Promise<T>) => {
      calls.transactions += 1;
      return fn(handle(true));
    },
  });
  const db = handle(false) as unknown as Reader;
  const opts = (q: string | undefined, offset = 0, limit = 5) => ({
    q,
    columns: [t.name, t.city],
    where: eq(t.id, 'scope-id'),
    orderBy: [sql`${t.id} asc`],
    limit,
    offset,
    count: (_tx: Reader, w: SQL | undefined) => {
      calls.counts.push(where(w));
      calls.countParams.push(params(w));
      return Promise.resolve(totals.shift() ?? 0);
    },
    rows: (_tx: Reader, p: PageQuery) => {
      calls.pages.push({
        where: where(p.where),
        order: p.orderBy.map(render),
        limit: p.limit,
        offset: p.offset,
      });
      return Promise.resolve(['row']);
    },
  });
  return { calls, db, opts };
}

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('searchPage', () => {
  it('lists with scope and filters only when there is no search', async () => {
    const { calls, db, opts } = setup([12]);
    const r = await searchPage(db, opts(undefined));
    expect(r).toEqual({ rows: ['row'], total: 12, fuzzy: false });
    expect(calls.counts[0]).not.toContain('ILIKE');
    expect(calls.executed).toEqual([]);
  });

  it('ignores a one-character search', async () => {
    const { calls, db, opts } = setup([3]);
    await searchPage(db, opts('a'));
    expect(calls.counts[0]).not.toContain('ILIKE');
  });

  it('uses exact matching only from FUZZY_THRESHOLD exact hits up, and never sets the threshold', async () => {
    const { calls, db, opts } = setup([5]);
    const r = await searchPage(db, opts('acme'));
    expect(r.fuzzy).toBe(false);
    expect(r.total).toBe(5);
    expect(calls.transactions).toBe(0);
    expect(calls.executed).toEqual([]);
    expect(calls.pages[0]?.where).toContain('ILIKE');
    expect(calls.pages[0]?.where).not.toContain('<%');
  });

  it('adds close matches below the threshold, inside a transaction with the threshold set', async () => {
    const { calls, db, opts } = setup([2, 6]);
    const r = await searchPage(db, opts('Himalayan'));
    expect(r).toEqual({ rows: ['row'], total: 6, fuzzy: true });
    expect(calls.transactions).toBe(1);
    expect(calls.executed).toHaveLength(1);
    expect(calls.executed[0]).toContain("set_config('pg_trgm.word_similarity_threshold'");
    // set_config(..., true): transaction-local.
    expect(calls.executed[0]).toMatch(/, true\)$/);
    // Scope and filter are in the count and the page of the fuzzy query.
    for (const w of [calls.counts[1], calls.pages[0]?.where]) {
      expect(w).toContain('"things"."id" = $1');
      expect(w).toContain('<%');
    }
    const order = calls.pages[0]?.order ?? [];
    expect(order[0]).toContain('DESC');
    expect(order[1]).toContain('word_similarity');
    expect(order[2]).toContain('"things"."id"');
  });

  it('keeps the same mode on page 2: the decision uses the total, not the page', async () => {
    // 3 exact hits in total; page 2 holds one row. A page-based rule would see 1 < 5 either way, but only the
    // total says "fuzzy"; with 5 exact in total, a short page 2 must stay exact.
    const exactish = setup([5]);
    const r = await searchPage(exactish.db, exactish.opts('acme', 4, 2));
    expect(r.fuzzy).toBe(false);
    expect(exactish.calls.pages[0]).toMatchObject({ offset: 4, limit: 2 });

    const fuzzy1 = setup([3, 7]);
    const fuzzy2 = setup([3, 7]);
    const p1 = await searchPage(fuzzy1.db, fuzzy1.opts('katmandu', 0, 5));
    const p2 = await searchPage(fuzzy2.db, fuzzy2.opts('katmandu', 5, 5));
    expect([p1.fuzzy, p1.total]).toEqual([true, 7]);
    expect([p2.fuzzy, p2.total]).toEqual([true, 7]);
    expect(fuzzy2.calls.pages[0]).toMatchObject({ offset: 5, limit: 5 });
  });

  it('skips fuzzy for a two-character search', async () => {
    const { calls, db, opts } = setup([0]);
    const r = await searchPage(db, opts('ab'));
    expect(r.fuzzy).toBe(false);
    expect(calls.transactions).toBe(0);
  });

  it('does not fetch a page past the end', async () => {
    const { calls, db, opts } = setup([3]);
    const r = await searchPage(db, opts(undefined, 10));
    expect(r.rows).toEqual([]);
    expect(calls.pages).toEqual([]);
  });

  it('escapes the search text as a parameter, not into the SQL', async () => {
    const { calls, db, opts } = setup([5]);
    await searchPage(db, opts("50%_x'; drop table t"));
    expect(calls.counts[0]).not.toContain('drop table');
    expect(calls.countParams[0]).toContain("%50\\%\\_x'; drop table t%");
  });

  it('refuses a search without columns', async () => {
    const { db, opts } = setup([0]);
    await expect(searchPage(db, { ...opts('acme'), columns: [] })).rejects.toThrow(/column/);
  });
});
