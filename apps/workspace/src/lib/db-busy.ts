import { ErrorBodySchema } from '@bos/contracts';

import { ApiError } from './api';

/** The API's 503 `db_busy` refusal and how many seconds it asks the caller to wait, or null for any other failure. */
export function dbBusyOf(err: unknown): { retryAfterSeconds: number } | null {
  if (!(err instanceof ApiError) || err.status !== 503) return null;
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (!parsed.success || parsed.data.error.code !== 'db_busy') return null;
  const wait = parsed.data.error.details?.retryAfterSeconds;
  return { retryAfterSeconds: typeof wait === 'number' && wait > 0 ? Math.ceil(wait) : 1 };
}
