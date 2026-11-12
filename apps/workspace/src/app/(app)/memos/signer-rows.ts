// The "Recommended by" rows of the memo form as plain data operations, so the rules are unit-tested:
// two blank rows to start, edits keep what is stored, blank rows never reach the API, at most 20.
import { MEMO_MAX_RECOMMENDERS } from '@bos/contracts';

/** A row holds a chosen staff user id, or '' while it is still blank. */
export type RecommenderRows = string[];

/** How many blank rows a new memo starts with. */
export const INITIAL_BLANK_RECOMMENDERS = 2;

/** New memo: two blank rows. Editing: exactly the stored recommenders, in their stored order, none invented. */
export function initialRecommenders(stored: readonly string[] | undefined): RecommenderRows {
  if (stored === undefined) return Array.from({ length: INITIAL_BLANK_RECOMMENDERS }, () => '');
  return [...stored];
}

export const canAddRecommender = (rows: RecommenderRows): boolean =>
  rows.length < MEMO_MAX_RECOMMENDERS;

/** Appends one blank row, or returns the same rows at the limit. */
export function addRecommender(rows: RecommenderRows): RecommenderRows {
  return canAddRecommender(rows) ? [...rows, ''] : rows;
}

export function removeRecommender(rows: RecommenderRows, index: number): RecommenderRows {
  return rows.filter((_, i) => i !== index);
}

export function setRecommender(
  rows: RecommenderRows,
  index: number,
  userId: string,
): RecommenderRows {
  return rows.map((current, i) => (i === index ? userId : current));
}

/** What the API gets: only rows with a person. A blank row is "not used yet", never an error. */
export function recommenderPayload(rows: RecommenderRows): string[] {
  return rows.filter((id) => id !== '');
}

/** Where focus goes after deleting row `removed` from `before` rows: the row now in its place, else the one above, else the Add button (null). */
export function focusAfterRemoval(removed: number, before: number): number | null {
  const after = before - 1;
  if (after <= 0) return null;
  return Math.min(removed, after - 1);
}
