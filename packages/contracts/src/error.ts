import { z } from 'zod';

/** Error body returned by every non-2xx API response. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    correlationId: z.string().min(1),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
