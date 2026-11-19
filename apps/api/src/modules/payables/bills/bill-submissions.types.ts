// Bodies of the staff routes over the vendor bill inbox (P4 unit A1d). The portal's rows are what the vendor
// claimed; staff add the lines when they convert and a reason when they reject. Both are strict, so a client cannot
// send a vendor, an invoice number, a total or a status: those come from the submission or the server.
import { MAX_ROWS, VendorBillLineBodySchema, searchParam } from '@bos/contracts';
import { z } from 'zod';

/** Convert a submission: the lines of the bill, in the shape of a bill create. */
export const ConvertBillSubmissionBodySchema = z.strictObject({
  lines: z.array(VendorBillLineBodySchema).min(1).max(200),
});
export type ConvertBillSubmissionBody = z.infer<typeof ConvertBillSubmissionBodySchema>;

/** Reject a submission: the reason is kept on the row and a blank one is refused. */
export const RejectBillSubmissionBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type RejectBillSubmissionBody = z.infer<typeof RejectBillSubmissionBodySchema>;

/**
 * Query of GET /v1/payables/bill-submissions: only a search and a page. Every row is `received`, so there is no
 * status filter. `limit` has no default: the bill entry screen looks a submission up in the whole inbox.
 */
export const ListBillSubmissionsQuerySchema = z.strictObject({
  q: searchParam,
  limit: z.coerce.number().int().min(1).max(MAX_ROWS).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListBillSubmissionsQuery = z.infer<typeof ListBillSubmissionsQuerySchema>;
