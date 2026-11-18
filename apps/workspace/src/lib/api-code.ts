import { ErrorBodySchema } from '@bos/contracts';

import { ApiError } from './api';

/**
 * The API's machine-readable error code (`primary_contact_exists`, `contact_email_required`, ...)
 * when `err` is an API answer that carries one. A screen switches on it to put a refusal next to
 * the field it is about instead of a generic sentence.
 */
export function apiCodeOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success ? parsed.data.error.code : undefined;
}
