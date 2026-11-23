import { ApiError } from '@/lib/api';

/** True for the API's answer to the link of a sent quotation that was cancelled (409 `quotation_closed`). */
export function isQuotationClosed(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body as { error?: { code?: unknown } } | null | undefined;
  return body?.error?.code === 'quotation_closed';
}
