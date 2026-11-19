// Contract tests of the read DTOs the workspace procurement screens use: the RFQ list query and row, and the inbox
// row of the convert screen. Strict objects, so a field added on one side only fails here.
import { describe, expect, it } from 'vitest';

import { ListRfqsQuerySchema, RfqListItemSchema, RfqSubmissionItemSchema } from './procurement.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ListRfqsQuerySchema', () => {
  it('defaults the limit to 50 and takes a status', () => {
    expect(ListRfqsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(ListRfqsQuerySchema.parse({ status: 'open', limit: '10' })).toEqual({
      status: ['open'],
      limit: 10,
      offset: 0,
    });
  });

  it('takes a repeated status, a search and an offset', () => {
    const parsed = ListRfqsQuerySchema.parse({
      status: ['open', 'closed', 'open'],
      q: '  chairs ',
      offset: '100',
    });
    expect(parsed).toEqual({ status: ['open', 'closed'], q: 'chairs', limit: 50, offset: 100 });
    expect(ListRfqsQuerySchema.parse({ q: 'a' }).q).toBeUndefined();
  });

  it('refuses one unknown status among valid ones, a repeated q and a negative offset', () => {
    expect(ListRfqsQuerySchema.safeParse({ status: ['open', 'done'] }).success).toBe(false);
    expect(ListRfqsQuerySchema.safeParse({ q: ['ab', 'cd'] }).success).toBe(false);
    expect(ListRfqsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('refuses an unknown status, a limit over 200 and an unknown key', () => {
    expect(ListRfqsQuerySchema.safeParse({ status: 'done' }).success).toBe(false);
    expect(ListRfqsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(ListRfqsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListRfqsQuerySchema.safeParse({ organizationId: id(1) }).success).toBe(false);
  });
});

describe('RfqListItemSchema', () => {
  const row = {
    id: id(1),
    number: 'RFQ-2082/83-00001',
    purchaseRequestId: id(2),
    purchaseRequestNumber: null,
    status: 'open',
    deadline: '2026-11-20T04:15:00.000Z',
    invitedVendorCount: 3,
    quotationCount: 0,
  };

  it('accepts the row shape, with a null request number', () => {
    expect(RfqListItemSchema.safeParse(row).success).toBe(true);
  });

  it('refuses a missing count and an extra key', () => {
    const { quotationCount: _q, ...short } = row;
    expect(RfqListItemSchema.safeParse(short).success).toBe(false);
    expect(RfqListItemSchema.safeParse({ ...row, tenantId: id(9) }).success).toBe(false);
  });
});

describe('RfqSubmissionItemSchema', () => {
  const row = {
    id: id(1),
    vendorId: id(2),
    vendorName: 'Himal Traders',
    vendorRef: null,
    submittedAt: '2026-11-09T04:00:00.000Z',
    documentId: id(3),
    scanStatus: 'clean',
  };

  it('accepts a scanned and an unscanned document', () => {
    expect(RfqSubmissionItemSchema.safeParse(row).success).toBe(true);
    expect(RfqSubmissionItemSchema.safeParse({ ...row, scanStatus: null }).success).toBe(true);
  });

  it('refuses a scan status the documents module does not have', () => {
    expect(RfqSubmissionItemSchema.safeParse({ ...row, scanStatus: 'ok' }).success).toBe(false);
  });
});
