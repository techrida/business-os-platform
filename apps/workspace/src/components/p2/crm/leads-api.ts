import 'server-only';

import { LEAD_STAGES, type LeadDto, LeadDtoSchema } from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

const ListSchema = z.array(LeadDtoSchema);

// Zero-filled by the API for every stage; the contracts package does not own this shape.
const SummarySchema = z.object({
  total: z.number().int().nonnegative(),
  byStage: z.object(
    Object.fromEntries(
      LEAD_STAGES.map((stage) => [stage, z.number().int().nonnegative()]),
    ) as Record<(typeof LEAD_STAGES)[number], z.ZodNumber>,
  ),
});
export type LeadSummary = z.infer<typeof SummarySchema>;

export type LeadsPage = { items: LeadDto[]; total: number };

type Filters = {
  q?: string | undefined;
  source?: readonly string[];
  ownerUserId?: readonly string[];
};

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function filterParams(opts: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  for (const source of opts.source ?? []) params.append('source', source);
  for (const owner of opts.ownerUserId ?? []) params.append('ownerUserId', owner);
  return params;
}

/**
 * One page of leads. The API answers a bare array and the number of all matches (same scope and
 * filters) in `X-Total-Count`. Multi-value filters repeat in the query string; an empty list omits them.
 */
export async function listLeadsPage(
  session: Session,
  opts: Filters & { stage?: readonly string[]; limit: number; offset?: number },
): Promise<LeadsPage> {
  const params = filterParams(opts);
  for (const stage of opts.stage ?? []) params.append('stage', stage);
  params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));

  const path = '/v1/leads';
  const res = await apiFetch(session, `${path}?${params.toString()}`);
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);

  const items = ListSchema.safeParse(body);
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
  if (!items.success || total === undefined) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, items.error?.issues);
  }
  return { items: items.data, total };
}

/** Per-stage counts for the same scope and filters as the list, except `stage`. */
export async function getLeadSummary(session: Session, opts: Filters = {}): Promise<LeadSummary> {
  const query = filterParams(opts).toString();
  const path = '/v1/leads/summary';
  const res = await apiFetch(session, query ? `${path}?${query}` : path);
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`, body);

  const parsed = SummarySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `GET ${path} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}
