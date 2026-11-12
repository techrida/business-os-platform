import { MEMO_MAX_RECOMMENDERS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  addRecommender,
  canAddRecommender,
  focusAfterRemoval,
  initialRecommenders,
  recommenderPayload,
  removeRecommender,
  setRecommender,
} from './signer-rows';

describe('recommender rows', () => {
  it('starts a new memo with two blank rows', () => {
    expect(initialRecommenders(undefined)).toEqual(['', '']);
  });

  it('keeps stored recommenders as they are when editing, and invents nothing', () => {
    expect(initialRecommenders(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(initialRecommenders(['a'])).toEqual(['a']);
    expect(initialRecommenders([])).toEqual([]);
  });

  it('does not mutate the stored list', () => {
    const stored = ['a'];
    const rows = initialRecommenders(stored);
    rows.push('b');
    expect(stored).toEqual(['a']);
  });

  it('sends only the chosen people, so one real signer works beside blank rows', () => {
    expect(recommenderPayload(['', 'u1', ''])).toEqual(['u1']);
    expect(recommenderPayload(['', ''])).toEqual([]);
    expect(recommenderPayload(['u1', 'u2'])).toEqual(['u1', 'u2']);
  });

  it('adds blank rows up to the contract limit and no further', () => {
    let rows = initialRecommenders(undefined);
    for (let i = 0; i < 40; i += 1) rows = addRecommender(rows);
    expect(rows).toHaveLength(MEMO_MAX_RECOMMENDERS);
    expect(canAddRecommender(rows)).toBe(false);
    expect(addRecommender(rows)).toBe(rows);
    expect(canAddRecommender(rows.slice(1))).toBe(true);
  });

  it('removes and sets rows by position', () => {
    expect(removeRecommender(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(setRecommender(['', ''], 1, 'u9')).toEqual(['', 'u9']);
  });

  it("puts focus on the row that took the removed row's place, else the one above, else the Add button", () => {
    expect(focusAfterRemoval(0, 3)).toBe(0);
    expect(focusAfterRemoval(1, 3)).toBe(1);
    expect(focusAfterRemoval(2, 3)).toBe(1);
    expect(focusAfterRemoval(0, 1)).toBeNull();
  });
});
