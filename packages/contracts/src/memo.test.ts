import { describe, expect, it } from 'vitest';

import { LetterheadSchema, MemoDirectorySchema, MemoTemplateSnapshotSchema } from './memo.js';

const ORG = '3f0c5a52-7c2e-4d0b-9a55-0e8d1d6a3b11';
const DEPT = '6b1e0a3c-2d4f-4a5b-8c6d-7e8f9a0b1c2d';
const USER = '9a8b7c6d-5e4f-4a3b-9c1d-0e1f2a3b4c5d';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const person = { userId: USER, name: 'Asha', jobTitle: null, department: null };
const snapshot = {
  organizationId: ORG,
  organizationName: 'Acme Pvt. Ltd.',
  departmentId: DEPT,
  departmentName: 'Sales',
  date: '2026-11-19',
  closing: 'Regards',
  preparedBy: person,
  recommenders: [],
  approvedBy: person,
};
const letterhead = {
  addressLines: ['Balaju', 'Kathmandu, Bagmati', 'Nepal'],
  logoDataUrl: PNG,
  primaryColour: '#1D4ED8',
};
const directory = {
  organizationId: ORG,
  organizationName: 'Acme Pvt. Ltd.',
  currentUserId: USER,
  departmentId: null,
  departments: [],
  people: [],
};

describe('memo letterhead', () => {
  it('still parses a template snapshot stored before letterheads', () => {
    const parsed = MemoTemplateSnapshotSchema.parse(snapshot);
    expect(parsed.letterhead).toBeUndefined();
  });

  it('parses a frozen letterhead and lower-cases its colour', () => {
    const parsed = MemoTemplateSnapshotSchema.parse({ ...snapshot, letterhead });
    expect(parsed.letterhead).toEqual({ ...letterhead, primaryColour: '#1d4ed8' });
  });

  it('carries the live letterhead on the directory, and parses one without it', () => {
    expect(MemoDirectorySchema.parse(directory).letterhead).toBeUndefined();
    expect(
      MemoDirectorySchema.parse({ ...directory, letterhead: { ...letterhead, logoDataUrl: null } })
        .letterhead?.logoDataUrl,
    ).toBeNull();
  });

  it('refuses more than four address lines, a line over 200 characters, an SVG logo and a bad colour', () => {
    expect(
      LetterheadSchema.safeParse({ ...letterhead, addressLines: ['a', 'b', 'c', 'd', 'e'] })
        .success,
    ).toBe(false);
    expect(
      LetterheadSchema.safeParse({ ...letterhead, addressLines: ['x'.repeat(201)] }).success,
    ).toBe(false);
    expect(
      LetterheadSchema.safeParse({
        ...letterhead,
        logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
      }).success,
    ).toBe(false);
    expect(LetterheadSchema.safeParse({ ...letterhead, primaryColour: 'blue' }).success).toBe(
      false,
    );
  });
});
