import { z } from 'zod';

/**
 * Why a 403 (or a 400) was refused, so the workspace can show the right message. `inactive_user` is
 * not in the plan's section 6.1 list but is in the section 6.2 `Decision` type, so it is allowed here
 * too. ADR 0027 §4 adds `entity_not_permitted` (403: the caller may not act for that entity, or it is
 * unknown) and `invalid_entity` (400: a malformed `X-Entity-Id` header).
 */
export const ERROR_REASONS = [
  'no_permission',
  'out_of_scope',
  'separation_of_duties',
  'mfa_required',
  'inactive_user',
  'entity_not_permitted',
  'invalid_entity',
  'stale_memo',
] as const;
export const ErrorReasonSchema = z.enum(ERROR_REASONS);
export type ErrorReason = z.infer<typeof ErrorReasonSchema>;

/** Error body returned by every non-2xx API response. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    correlationId: z.string().min(1),
    /** Present only for allow-listed reasons. */
    reason: ErrorReasonSchema.optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
