// Query of the bill inbox list: a search and a page, no status, and no default limit (the bill entry screen reads
// the whole inbox).
// Run: pnpm --filter @bos/api exec vitest run src/modules/payables/bills/bill-submissions.types.test.ts
import { describe, expect, it } from 'vitest';

import { ListBillSubmissionsQuerySchema } from './bill-submissions.types';

describe('ListBillSubmissionsQuerySchema', () => {
  it('has no limit unless one is sent', () => {
    expect(ListBillSubmissionsQuerySchema.parse({})).toEqual({ offset: 0 });
    expect(ListBillSubmissionsQuerySchema.parse({ q: 'inv', limit: '25', offset: '50' })).toEqual({
      q: 'inv',
      limit: 25,
      offset: 50,
    });
  });

  it('ignores a one-letter search and refuses a status, a big limit and an unknown key', () => {
    expect(ListBillSubmissionsQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
    expect(ListBillSubmissionsQuerySchema.safeParse({ status: 'received' }).success).toBe(false);
    expect(ListBillSubmissionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListBillSubmissionsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});
