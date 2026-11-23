import { describe, expect, it } from 'vitest';

import { memoRowNote, memoSummaryCards, safeCursor } from './memo-list-view';

describe('memoRowNote', () => {
  it('joins department and creator', () => {
    expect(memoRowNote({ departmentName: 'Finance', ownerName: 'Sushil Shrestha' })).toBe(
      'Finance · by Sushil Shrestha',
    );
  });
  it('leaves out what the directory does not have, and never prints "null"', () => {
    expect(memoRowNote({ departmentName: null, ownerName: 'सुशील श्रेष्ठ' })).toBe('by सुशील श्रेष्ठ');
    expect(memoRowNote({ departmentName: 'Finance', ownerName: null })).toBe('Finance');
    expect(memoRowNote({ departmentName: null, ownerName: null })).toBe('');
    expect(memoRowNote({ departmentName: '  ', ownerName: ' ' })).toBe('');
  });
});

describe('safeCursor', () => {
  it('passes a plausible cursor and drops arrays, empty and hostile values', () => {
    expect(safeCursor('WyIyMDI2LTExLTAxVDA0OjAwOjAwLjAwMDAwMFoiLCJhYiJd')).toBe(
      'WyIyMDI2LTExLTAxVDA0OjAwOjAwLjAwMDAwMFoiLCJhYiJd',
    );
    expect(safeCursor(['a', 'b'])).toBeUndefined();
    expect(safeCursor('')).toBeUndefined();
    expect(safeCursor(undefined)).toBeUndefined();
    expect(safeCursor('a b')).toBeUndefined();
    expect(safeCursor("x';--")).toBeUndefined();
    expect(safeCursor('a'.repeat(301))).toBeUndefined();
  });
});

describe('memoSummaryCards', () => {
  it('sums every status into "All memos", including statuses without a card', () => {
    const cards = memoSummaryCards({
      draft: 2,
      submitted: 3,
      returned: 1,
      approved: 4,
      rejected: 5,
    });
    expect(cards.map((c) => [c.label, c.value])).toEqual([
      ['All memos', 15],
      ['Drafts', 2],
      ['Waiting for approval', 3],
      ['Returned', 1],
      ['Approved', 4],
    ]);
  });
  it('shows a real zero for a status with no memos', () => {
    expect(memoSummaryCards({ draft: 1 }).find((c) => c.key === 'approved')?.value).toBe(0);
  });
});
