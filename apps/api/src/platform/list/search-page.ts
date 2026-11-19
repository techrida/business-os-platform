// One search-and-page helper for every list endpoint (U13). The module supplies its own select (joins, scope,
// filters); this decides between exact and typo-tolerant search and keeps paging stable.
//
// Mode is decided from the TOTAL number of exact (substring) matches under the same scope and filters, never from
// the page rows: page 2 of a search must not flip between exact and fuzzy. When the exact total is below
// FUZZY_THRESHOLD and q is at least FUZZY_MIN_LENGTH long, one more query returns exact hits first (in the
// caller's order) and then close matches by similarity. Scope and filters are part of `where`, so both queries
// carry them: a fuzzy match never reaches a row the caller could not see.
//
// Example (LeadsService.list):
//   const { rows, total } = await searchPage(this.db, {
//     q: query.q,
//     columns: [leads.title, leads.number, leads.companyName, leads.contactName],
//     where: scoped(scope).where(leads, and(...filters)),
//     orderBy: [desc(leads.createdAt), desc(leads.id)],
//     limit: query.limit,
//     offset: query.offset,
//     rows: (tx, p) =>
//       tx.select().from(leads).where(p.where).orderBy(...p.orderBy).limit(p.limit).offset(p.offset),
//     count: (tx, where) => tx.$count(leads, where),
//   });
import { FUZZY_MIN_LENGTH, FUZZY_THRESHOLD, MIN_SEARCH_LENGTH } from '@bos/contracts';
import { and, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { type Db, type DbTransaction, inTransaction } from '../db/db.module';

/** A text column, or a SQL expression of type text (cast other types: sql`${t.number}::text`). */
export type SearchColumn = AnyPgColumn | SQL;

/** What a module's `rows` and `count` callbacks run their queries on: the pool handle or a transaction. */
export type Reader = Db | DbTransaction;

export interface PageQuery {
  where: SQL | undefined;
  orderBy: SQL[];
  limit: number;
  offset: number;
}

export interface SearchPageOptions<Row> {
  /** The search text; blank or shorter than MIN_SEARCH_LENGTH means no search. */
  q: string | undefined;
  /** The searchable text columns (may come from joined tables). At least one. */
  columns: readonly SearchColumn[];
  /** Scope AND filters. Never include the search here; the helper adds it. */
  where: SQL | undefined;
  /** The default order. Must end in a unique key (usually the id) or OFFSET paging can shuffle. */
  orderBy: readonly SQL[];
  limit: number;
  offset: number;
  /** Selects one page: `tx.select().from(t).where(p.where).orderBy(...p.orderBy).limit(p.limit).offset(p.offset)`. */
  rows: (tx: Reader, page: PageQuery) => Promise<Row[]>;
  /** Counts rows matching `where`: `tx.$count(table, where)`, or a select over the same joins. */
  count: (tx: Reader, where: SQL | undefined) => Promise<number>;
}

export interface SearchPageResult<Row> {
  rows: Row[];
  /** All rows matching scope + filters + search (exact, plus close matches in fuzzy mode), not just this page. */
  total: number;
  /** True when close (typo-tolerant) matches are included after the exact ones. */
  fuzzy: boolean;
}

/** Below pg_trgm's default 0.6: 'Himalayan' vs 'Himalyan Traders' scores 0.58. Set per transaction only. */
export const FUZZY_WORD_SIMILARITY = '0.4';

/** `%` and `_` are wildcards in LIKE; a search for "50%" must match the text, not everything. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** True when any column contains q, case-insensitively. NULL columns count as no match (never NULL overall). */
export function exactMatch(q: string, columns: readonly SearchColumn[]): SQL {
  const pattern = `%${escapeLike(q)}%`;
  const any = or(...columns.map((c) => sql`${c} ILIKE ${pattern}`));
  return sql`coalesce(${any}, false)`;
}

/** `q <% column` is the form the trigram GIN index serves (the function form does a sequential scan). */
export function fuzzyMatch(q: string, columns: readonly SearchColumn[]): SQL {
  return or(...columns.map((c) => sql`${q}::text <% ${c}`)) as SQL;
}

/** The best word similarity of q over the columns; NULL columns score 0. */
export function similarity(q: string, columns: readonly SearchColumn[]): SQL {
  const scores = columns.map((c) => sql`coalesce(word_similarity(${q}::text, ${c}), 0)`);
  return sql`GREATEST(${sql.join(scores, sql`, `)})`;
}

/**
 * Runs a search over one page.
 *
 * `db` is the pool handle the service already holds (`this.db`): reads in this codebase do not run in a request
 * transaction, so the fuzzy step opens its own, which is what makes the threshold `set_config(..., true)`
 * transaction-local. Given a transaction instead, the call becomes a savepoint and the setting then lasts until
 * the outer transaction ends.
 */
export async function searchPage<Row>(
  db: Reader,
  o: SearchPageOptions<Row>,
): Promise<SearchPageResult<Row>> {
  const q = o.q?.trim();
  const orderBy = [...o.orderBy];
  const page = async (
    tx: Reader,
    where: SQL | undefined,
    order: SQL[],
    total: number,
  ): Promise<Row[]> =>
    // Past the last row there is nothing to fetch; the count alone answers.
    o.offset >= total
      ? []
      : o.rows(tx, { where, orderBy: order, limit: o.limit, offset: o.offset });

  if (q === undefined || q.length < MIN_SEARCH_LENGTH) {
    const total = await o.count(db, o.where);
    return { rows: await page(db, o.where, orderBy, total), total, fuzzy: false };
  }
  if (o.columns.length === 0) throw new Error('searchPage() needs at least one search column');

  const exact = exactMatch(q, o.columns);
  const exactWhere = and(o.where, exact);
  const exactTotal = await o.count(db, exactWhere);
  if (exactTotal >= FUZZY_THRESHOLD || q.length < FUZZY_MIN_LENGTH) {
    return {
      rows: await page(db, exactWhere, orderBy, exactTotal),
      total: exactTotal,
      fuzzy: false,
    };
  }

  return inTransaction(db as Db, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${FUZZY_WORD_SIMILARITY}, true)`,
    );
    const where = and(o.where, or(exact, fuzzyMatch(q, o.columns)));
    const total = await o.count(tx, where);
    // Exact hits first, in the caller's order; then close matches, best first.
    const order = [
      sql`${exact} DESC`,
      sql`CASE WHEN ${exact} THEN 0 ELSE ${similarity(q, o.columns)} END DESC`,
      ...orderBy,
    ];
    return { rows: await page(tx, where, order, total), total, fuzzy: true };
  });
}
