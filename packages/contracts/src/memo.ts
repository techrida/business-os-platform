// The throwaway "test memo" document that exercises every kernel service end to end.
// P2 replaces it with quotations; fields follow app.test_memos in section 4.
import { z } from 'zod';

import { CurrencySchema, DecimalString, RateString } from './money.js';

export const MEMO_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'rejected'] as const;
export const MemoStatusSchema = z.enum(MEMO_STATUSES);

export const CreateMemoBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000),
  /** The table has CHECK (amount >= 0), so a negative amount is refused here with a clear message. */
  amount: DecimalString.refine((v) => !v.startsWith('-'), 'must not be negative'),
  currency: CurrencySchema,
});
export type CreateMemoBody = z.infer<typeof CreateMemoBodySchema>;

export const MemoDtoSchema = z.object({
  id: z.guid(),
  number: z.string(),
  title: z.string(),
  body: z.string(),
  amount: DecimalString,
  currency: CurrencySchema,
  amountNpr: DecimalString,
  fxRate: RateString,
  fxSource: z.string(),
  fxDate: z.iso.date(),
  status: MemoStatusSchema,
  ownerUserId: z.guid(),
  departmentId: z.guid().nullable(),
  /** The counterparty org a portal would show this memo to (ADR 0017); null for internal memos. */
  customerOrganizationId: z.guid().nullable(),
  editorUserIds: z.array(z.guid()),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoDto = z.infer<typeof MemoDtoSchema>;
