import 'server-only';

import { type ActivityDto, ActivityDtoSchema, type ActivityKind } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

const ListSchema = z.array(ActivityDtoSchema);

export type ActivitiesPage = { items: ActivityDto[]; total: number };

/**
 * One page of the activities the caller may read. The API answers a bare array and the number of all matches
 * (same scope and filters) in `X-Total-Count`. `kind` repeats in the query string; an empty list omits it.
 */
export async function listActivitiesPage(
  session: Session,
  opts: {
    kind?: readonly ActivityKind[];
    q?: string | undefined;
    limit: number;
    offset?: number;
  },
): Promise<ActivitiesPage> {
  const params = new URLSearchParams();
  for (const kind of opts.kind ?? []) params.append('kind', kind);
  if (opts.q) params.set('q', opts.q);
  params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));

  const path = '/v1/activities';
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
