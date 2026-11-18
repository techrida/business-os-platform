import 'server-only';

import {
  type ListQuotationsQuery,
  type QuotationDetail,
  QuotationDetailSchema,
  type QuotationListItem,
  QuotationListItemSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/**
 * Typed reads of the quotation endpoints, for the screens in this folder. Server-only: every call
 * carries the user's access token. Each response is parsed with the contract's schema, so an API
 * that drifts from the contract fails loudly (502) instead of rendering `undefined`. Writes belong
 * to the units that need them.
 */

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function get<T>(session: Session, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  const label = `GET ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

/**
 * `GET /v1/quotations[?status=&opportunityId=]`: a bare array of list rows. Both filters are optional;
 * the API still limits the rows to what the caller may read.
 */
export function listQuotations(
  session: Session,
  filter: ListQuotationsQuery = {},
): Promise<QuotationListItem[]> {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.opportunityId !== undefined) params.set('opportunityId', filter.opportunityId);
  const query = params.size === 0 ? '' : `?${params.toString()}`;
  return get(session, `/v1/quotations${query}`, z.array(QuotationListItemSchema));
}

/** `GET /v1/quotations/:id`: the parent, every version, the status history and the contacts. */
export function getQuotation(session: Session, id: string): Promise<QuotationDetail> {
  return get(session, `/v1/quotations/${seg(id)}`, QuotationDetailSchema);
}
