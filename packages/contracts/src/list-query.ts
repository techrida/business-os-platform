// Shared query-string pieces for list endpoints and their screens (U13): repeated filter params, the search box
// and paging. The same module serves the API (strict query schemas) and the workspace (URL building).
import { z } from 'zod';

/** A search shorter than this is ignored: two characters match too much to be a useful narrowing. */
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 100;
/** Fewer exact (substring) matches than this, in total, lets the API add typo-tolerant matches. */
export const FUZZY_THRESHOLD = 5;
/** Trigram matching needs at least one trigram of the word to be meaningful. */
export const FUZZY_MIN_LENGTH = 3;
/** The most values one repeated filter param accepts. */
export const MULTI_MAX = 20;

export const DEFAULT_ROWS = 25;
export const ROWS_OPTIONS = [10, 25, 50, 100] as const;
export const MAX_ROWS = 100;

/**
 * A filter that may repeat in the query string: `?status=new&status=contacted`. A single value arrives as a
 * string, repeats as an array. Empty values are dropped (`?status=` is "no filter"), duplicates are removed
 * keeping first position, each value is checked by `schema` (an unknown value is a 400 through parseOr400)
 * and there are at most MULTI_MAX. The output key is optional, so it works in `z.strictObject({...})`.
 */
export function multi<S extends z.ZodType>(schema: S) {
  return z
    .preprocess(
      (value) => {
        if (value === undefined) return undefined;
        const list: unknown[] = Array.isArray(value) ? value : [value];
        return list.filter((v) => v !== '');
      },
      z
        .array(schema)
        .max(MULTI_MAX)
        .transform((values) => [...new Set(values)])
        .optional(),
    )
    .optional();
}

/**
 * The `q` search param: trimmed, at most MAX_SEARCH_LENGTH. Blank or shorter than MIN_SEARCH_LENGTH means
 * "no search" (undefined) instead of an error, so a half-typed URL still shows the list. A repeated `q` is a 400.
 */
export const searchParam = z
  .string()
  .trim()
  .max(MAX_SEARCH_LENGTH)
  .transform((s) => (s.length >= MIN_SEARCH_LENGTH ? s : undefined))
  .optional();

/** `limit` and `offset` for an API list query (they arrive as text, so they are coerced). */
export function limitOffset(options: { max?: number; fallback?: number } = {}) {
  const max = options.max ?? MAX_ROWS;
  return {
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(max)
      .default(options.fallback ?? DEFAULT_ROWS),
    offset: z.coerce.number().int().min(0).default(0),
  };
}

export interface PageWindow {
  /** The page shown, 1-based. Clamped to the last page when `total` is known. */
  page: number;
  pageCount: number;
  limit: number;
  offset: number;
  /** 1-based position of the first and last row on this page; both 0 when there are no rows. */
  first: number;
  last: number;
}

/** Turns the URL's `page` and `rows` into SQL `limit`/`offset`; with `total` it also clamps and counts. */
export function pageWindow(page: number, rows: number, total?: number): PageWindow {
  const limit = Math.max(1, Math.floor(rows));
  const want = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  if (total === undefined) {
    const offset = (want - 1) * limit;
    return { page: want, pageCount: want, limit, offset, first: offset + 1, last: offset + limit };
  }
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const shown = Math.min(want, pageCount);
  const offset = (shown - 1) * limit;
  return {
    page: shown,
    pageCount,
    limit,
    offset,
    first: total === 0 ? 0 : offset + 1,
    last: Math.min(offset + limit, total),
  };
}
