import { z } from 'zod';

/**
 * Why a 403 was refused, so the workspace can show the right message. `inactive_user` is not in
 * the plan's section 6.1 list but is in the section 6.2 `Decision` type, so it is allowed here too.
 */
export const ERROR_REASONS = [
  'no_permission',
  'out_of_scope',
  'separation_of_duties',
  'mfa_required',
  'inactive_user',
] as const;
export const ErrorReasonSchema = z.enum(ERROR_REASONS);
export type ErrorReason = z.infer<typeof ErrorReasonSchema>;

/** Error body returned by every non-2xx API response. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    correlationId: z.string().min(1),
    /** Present only on some 403 responses. */
    reason: ErrorReasonSchema.optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
