import { describe, expect, it } from 'vitest';

import { fileNameFrom, substitutionNote } from './memo-pdf-client';

describe('download feedback text (shown as a toast, never beside a button)', () => {
  it('says nothing when every character could be drawn', () => {
    expect(substitutionNote(0)).toBe('');
    expect(substitutionNote(Number.NaN)).toBe('');
  });

  it('counts the replaced characters in the singular and the plural', () => {
    expect(substitutionNote(1)).toMatch(/^1 character the PDF fonts cannot draw .* was replaced/);
    expect(substitutionNote(3)).toMatch(/^3 characters .* were replaced/);
  });

  it('takes the file name the server sent, else a safe default', () => {
    expect(fileNameFrom('attachment; filename="MEMO-1-budget.pdf"')).toBe('MEMO-1-budget.pdf');
    expect(fileNameFrom(null)).toBe('memo.pdf');
    expect(fileNameFrom('attachment; filename="../../etc/passwd"')).toBe('memo.pdf');
  });
});
