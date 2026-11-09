// Bodies of the staff routes over the vendor bill inbox (P4 unit A1d). The portal's rows are what the vendor
// claimed; staff add the lines when they convert and a reason when they reject. Both are strict, so a client cannot
// send a vendor, an invoice number, a total or a status: those come from the submission or the server.
import { VendorBillLineBodySchema } from '@bos/contracts';
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
