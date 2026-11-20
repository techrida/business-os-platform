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

/**
 * The allow-listed refusal reason (`duplicate_reason_required`, ...) an API answer carries in
 * `error.reason`, beside its generic `code`. A screen switches on it where the code alone
 * (`bad_request`) says too little.
 */
export function apiReasonOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success ? parsed.data.error.reason : undefined;
}

/**
 * One allow-listed fact from an API refusal's `error.details` (`assignmentReason`, `opportunityId`,
 * ...), as the API sent it. Absent when the answer is not an API error or carries no such detail.
 */
export function apiDetailOf(err: unknown, key: string): string | number | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success ? parsed.data.error.details?.[key] : undefined;
}
