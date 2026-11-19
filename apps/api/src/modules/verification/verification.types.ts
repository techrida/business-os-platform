// Request shapes that only the verification routes use. The DTO and the attach and review bodies live in
// @bos/contracts (crm.ts). Serves the NFR "inputs are validated at the edge".
import {
  AttachVerificationDocumentBodySchema,
  limitOffset,
  multi,
  ReviewVerificationBodySchema,
  searchParam,
  VerificationPartyKindSchema,
  VerificationStatusSchema,
} from '@bos/contracts';
import { z } from 'zod';

/** The `ownerType` of the documents that belong to a case. */
export const VERIFICATION_OWNER_TYPE = 'verification_case';

/** POST /v1/verification-cases: which customer the case is for (one case per customer). */
export const CreateVerificationCaseBodySchema = z.strictObject({ partyId: z.guid() });
export type CreateVerificationCaseBody = z.infer<typeof CreateVerificationCaseBodySchema>;

/**
 * GET /v1/verification-cases?q&status&partyKind&partyId&limit&offset. `status` and `partyKind` may repeat; `q`
 * searches the party's name and code. A bare array comes back, with the full count in X-Total-Count.
 */
export const ListVerificationCasesQuerySchema = z.strictObject({
  q: searchParam,
  status: multi(VerificationStatusSchema),
  partyKind: multi(VerificationPartyKindSchema),
  partyId: z.guid().optional(),
  ...limitOffset({ max: 100, fallback: 25 }),
});
export type ListVerificationCasesQuery = z.infer<typeof ListVerificationCasesQuerySchema>;

/** PATCH /v1/verification-cases/:id/checklist: the contract's body, one item per call. */
export const SetChecklistBodySchema = AttachVerificationDocumentBodySchema;

/**
 * POST /v1/verification-cases/:id/decision. The contract needs a comment only to reject; the review screen
 * asks for one on approval too, so the API does as well (the note is what the audit trail shows).
 */
export const DecisionBodySchema = ReviewVerificationBodySchema.refine(
  (b) => b.comment !== undefined,
  {
    path: ['comment'],
    message: 'a comment is required',
  },
);
export type DecisionBody = z.infer<typeof DecisionBodySchema>;

/** Printable ASCII, 1 to 200 characters: the same rule as the approvals routes. */
export const IdempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);
