// Request and response shapes that only the test memo routes use. The create body and MemoDto live in
// @bos/contracts (memo.ts); the update body and the GET response are local because the e2e and k6 units are the
// only other readers. Serves the NFR "inputs are validated at the edge".
import {
  MemoBodyFieldsSchema,
  type DocumentVersionDto,
  type MemoApproverRule,
  type MemoDto,
} from '@bos/contracts';
import { z } from 'zod';

/**
 * PATCH body: any subset of the create fields, at least one, nothing else (a typo is a 400, not a silent no-op).
 * `amount` and `currency` are legacy: sending either re-freezes the NPR value, leaving them out keeps what is stored.
 */
export const UpdateMemoBodySchema = z
  .strictObject({
    template: MemoBodyFieldsSchema.shape.template,
    title: MemoBodyFieldsSchema.shape.title.optional(),
    body: MemoBodyFieldsSchema.shape.body.optional(),
    amount: MemoBodyFieldsSchema.shape.amount,
    currency: MemoBodyFieldsSchema.shape.currency,
    expectedVersion: z.int().positive().optional(),
  })
  .refine(
    (b) =>
      Object.entries(b).some(([key, value]) => key !== 'expectedVersion' && value !== undefined),
    'at least one field is required',
  );
export type UpdateMemoBody = z.infer<typeof UpdateMemoBodySchema>;

export const SubmitMemoBodySchema = z.object({ expectedVersion: z.int().positive().optional() });

export const MEMO_OWNER_TYPE = 'test_memo';

/** The approval request of a memo, if it was ever submitted (the newest one). */
export interface MemoApprovalSummary {
  requestId: string;
  status: 'pending' | 'approved' | 'returned' | 'rejected' | 'blocked' | 'cancelled';
}

/** GET /v1/test-memos/:id */
export type MemoDetailDto = MemoDto & {
  canUpdate: boolean;
  attachments: DocumentVersionDto[];
  approval: MemoApprovalSummary | null;
  /** Who may approve this memo if it were submitted now (F1-Q9). Only for a template memo the caller may edit. */
  approverRule?: MemoApproverRule;
};

/** POST /v1/test-memos/:id/submit */
export interface SubmitMemoResult {
  requestId: string;
  status: 'pending' | 'blocked';
}
