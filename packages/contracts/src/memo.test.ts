import { describe, expect, it } from 'vitest';

import { MEMO_LIST_DEFAULT_LIMIT, MemoListQuerySchema } from './memo.js';

describe('MemoListQuerySchema', () => {
  it('keeps the old defaults when no filter is given', () => {
    const query = MemoListQuerySchema.parse({});
    expect(query.limit).toBe(MEMO_LIST_DEFAULT_LIMIT);
    expect(query.status).toBeUndefined();
    expect(query.q).toBeUndefined();
  });

  it('accepts one status and a repeated status, once each', () => {
    expect(MemoListQuerySchema.parse({ status: 'draft' }).status).toEqual(['draft']);
    expect(MemoListQuerySchema.parse({ status: ['draft', 'approved', 'draft'] }).status).toEqual([
      'draft',
      'approved',
    ]);
  });

  it('refuses an unknown status, in any position', () => {
    expect(MemoListQuerySchema.safeParse({ status: 'weird' }).success).toBe(false);
    expect(MemoListQuerySchema.safeParse({ status: ['draft', 'weird'] }).success).toBe(false);
  });

  it('refuses unknown parameters and a repeated q', () => {
    expect(MemoListQuerySchema.safeParse({ ownerUserId: 'x' }).success).toBe(false);
    expect(MemoListQuerySchema.safeParse({ offset: '5' }).success).toBe(false);
    expect(MemoListQuerySchema.safeParse({ q: ['a1', 'b2'] }).success).toBe(false);
  });

  it('trims q and treats a one-character q as no search', () => {
    expect(MemoListQuerySchema.parse({ q: '  MEMO-26  ' }).q).toBe('MEMO-26');
    expect(MemoListQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
  });

  it('keeps the cursor and the limit ceiling', () => {
    expect(MemoListQuerySchema.parse({ cursor: 'abc_-1', limit: '50' }).limit).toBe(50);
    expect(MemoListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(MemoListQuerySchema.safeParse({ cursor: 'not valid!' }).success).toBe(false);
  });
});
