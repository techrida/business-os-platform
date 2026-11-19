import 'server-only';

import { type OpportunityDto, OpportunityDtoSchema } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

const ListSchema = z.array(OpportunityDtoSchema);

export type OpportunitiesPage = { items: OpportunityDto[]; total: number };

/**
 * One page of opportunities. The API answers a bare array and the number of all matches (same scope and
 * filters) in `X-Total-Count`. `stage` and `owner` repeat in the query string; an empty list omits the filter.
 */
export async function listOpportunitiesPage(
  session: Session,
  opts: {
    stage?: readonly string[];
    owner?: readonly string[];
    q?: string | undefined;
    limit: number;
    offset?: number;
  },
): Promise<OpportunitiesPage> {
  const params = new URLSearchParams();
  for (const stage of opts.stage ?? []) params.append('stage', stage);
  for (const owner of opts.owner ?? []) params.append('owner', owner);
  if (opts.q) params.set('q', opts.q);
  params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));

  const path = '/v1/opportunities';
  const res = await apiFetch(session, `${path}?${params.toString()}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);

  const items = ListSchema.safeParse(body);
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
  if (!items.success || total === undefined) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, items.error?.issues);
  }
  return { items: items.data, total };
}
