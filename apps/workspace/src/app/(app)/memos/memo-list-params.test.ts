import { describe, expect, it } from 'vitest';

import { hrefWith, readList } from '@/lib/list-params';

import { cursorOf, MEMO_LIST_SPEC } from './memo-list-params';

describe('memo list URL', () => {
  it('reads repeated statuses, dropping unknown ones, and the search text', () => {
    const { q, multi } = readList(
      { status: ['draft', 'bogus', 'approved'], q: ' budget ' },
      MEMO_LIST_SPEC,
    );
    expect(multi.status).toEqual(['draft', 'approved']);
    expect(q).toBe('budget');
  });

  it('keeps the cursor in `page`, and a filter change drops it', () => {
    expect(cursorOf({ page: 'WyIyMDI2' })).toBe('WyIyMDI2');
    expect(cursorOf({ page: ['a', 'b'] })).toBeUndefined();
    expect(cursorOf({ page: 'not valid!' })).toBeUndefined();
    expect(
      hrefWith('/memos', { page: 'WyIyMDI2', status: 'draft' }, { status: ['approved'] }),
    ).toBe('/memos?status=approved');
  });
});
