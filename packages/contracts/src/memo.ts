// The throwaway "test memo" document that exercises every kernel service end to end.
// P2 replaces it with quotations; fields follow app.test_memos in section 4.
import { z } from 'zod';

import { CurrencySchema, DecimalString, RateString } from './money.js';

export const MEMO_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'rejected'] as const;
export const MemoStatusSchema = z.enum(MEMO_STATUSES);

export const MemoPersonSchema = z.object({
  userId: z.guid(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  department: z.string().nullable(),
});
export const MemoTemplateInputSchema = z
  .object({
    departmentId: z.guid(),
    date: z.iso.date(),
    closing: z.string().trim().max(1000),
    preparedByUserId: z.guid(),
    recommenderUserIds: z.array(z.guid()).max(20),
    approvedByUserId: z.guid(),
  })
  .superRefine((v, ctx) => {
    const ids = [v.preparedByUserId, ...v.recommenderUserIds, v.approvedByUserId];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Choose different people for each role' });
  });
export const MemoTemplateSnapshotSchema = z.object({
  organizationId: z.guid(),
  organizationName: z.string(),
  departmentId: z.guid(),
  departmentName: z.string(),
  date: z.iso.date(),
  closing: z.string(),
  preparedBy: MemoPersonSchema,
  recommenders: z.array(MemoPersonSchema),
  approvedBy: MemoPersonSchema,
});
export type MemoTemplateSnapshot = z.infer<typeof MemoTemplateSnapshotSchema>;
export const MemoDirectorySchema = z.object({
  organizationId: z.guid(),
  organizationName: z.string(),
  currentUserId: z.guid(),
  departmentId: z.guid().nullable(),
  departments: z.array(z.object({ id: z.guid(), name: z.string() })),
  people: z.array(MemoPersonSchema),
});
export type MemoDirectory = z.infer<typeof MemoDirectorySchema>;

export const CreateMemoBodySchema = z.object({
  template: MemoTemplateInputSchema.optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10_000),
  /** The table has CHECK (amount >= 0), so a negative amount is refused here with a clear message. */
  amount: DecimalString.refine((v) => !v.startsWith('-'), 'must not be negative'),
  currency: CurrencySchema,
  /**
   * The customer party a portal would show this memo to (ADR 0027 §5); omit or null for an internal memo. The
   * database checks that it is a customer party of the tenant (test_memos_customer_party_fk).
   */
  customerPartyId: z.guid().nullable().optional(),
});
export type CreateMemoBody = z.infer<typeof CreateMemoBodySchema>;

export const MemoDtoSchema = z.object({
  template: MemoTemplateSnapshotSchema.nullable().optional(),
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
  /** The customer party a portal would show this memo to (ADR 0027 §5); null for internal memos. */
  customerPartyId: z.guid().nullable(),
  editorUserIds: z.array(z.guid()),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type MemoDto = z.infer<typeof MemoDtoSchema>;
