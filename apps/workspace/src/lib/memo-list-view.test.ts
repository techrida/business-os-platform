import { describe, expect, it } from 'vitest';

import { memoRowNote, safeCursor } from './memo-list-view';

describe('memoRowNote', () => {
  it('joins department and creator', () => {
    expect(memoRowNote({ departmentName: 'Finance', ownerName: 'Sushil Shrestha' })).toBe(
      'Finance · by Sushil Shrestha',
    );
  });
  it('leaves out what the directory does not have, and never prints "null"', () => {
    expect(memoRowNote({ departmentName: null, ownerName: 'सुशील श्रेष्ठ' })).toBe(
      'by सुशील श्रेष्ठ',
    );
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
