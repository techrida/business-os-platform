// Request and response shapes that only the test memo routes use. The create body and MemoDto live in
// @bos/contracts (memo.ts); the update body and the GET response are local because the e2e and k6 units are the
// only other readers. Serves the NFR "inputs are validated at the edge".
import { MemoBodyFieldsSchema, type DocumentVersionDto, type MemoDto } from '@bos/contracts';
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
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'at least one field is required');
export type UpdateMemoBody = z.infer<typeof UpdateMemoBodySchema>;

export const MEMO_OWNER_TYPE = 'test_memo';

/** The approval request of a memo, if it was ever submitted (the newest one). */
export interface MemoApprovalSummary {
  requestId: string;
  status: 'pending' | 'approved' | 'returned' | 'rejected' | 'blocked' | 'cancelled';
}

/** GET /v1/test-memos/:id */
export type MemoDetailDto = MemoDto & {
  attachments: DocumentVersionDto[];
  approval: MemoApprovalSummary | null;
};

/** POST /v1/test-memos/:id/submit */
export interface SubmitMemoResult {
  requestId: string;
  status: 'pending' | 'blocked';
}
