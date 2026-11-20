import 'server-only';

import {
  QUOTATION_STATUSES,
  QuotationDetailSchema,
  type QuotationListItem,
  QuotationListItemSchema,
  type QuotationSummary,
  QuotationSummarySchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import {
  lifecyclePaths,
  QuotationEvidenceSchema,
  readLifecycle,
  type QuotationDetailWithLifecycle,
  type QuotationEvidence,
} from './lifecycle-contract';

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

async function read<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
): Promise<{ data: T; res: Response; body: unknown }> {
  const res = await apiFetch(session, path, { method: 'GET' });
  const body = await readBody(res);
  const label = `GET ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return { data: parsed.data, res, body };
}

async function get<T>(session: Session, path: string, schema: z.ZodType<T>): Promise<T> {
  return (await read(session, path, schema)).data;
}

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most values one repeated filter carries; the API refuses more. */
const MAX_FILTER_VALUES = 20;

type Many<T> = T | readonly T[];

/**
 * The list's query as callers write it: a filter takes one value or several. Typed here rather than
 * with `z.input` of the contract schema, which types the repeatable fields as `unknown`.
 */
export interface QuotationListFilter {
  /** Contract statuses; anything else is dropped before the call (the URL is user-editable). */
  status?: Many<string> | undefined;
  customerId?: Many<string> | undefined;
  opportunityId?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** The summary takes the list's filters except status and paging. */
export type QuotationSummaryFilter = Pick<
  QuotationListFilter,
  'customerId' | 'opportunityId' | 'q'
>;

/** Repeated `name=value` pairs, once each; values that are not valid are dropped, never sent. */
function repeated(
  name: string,
  raw: Many<string> | undefined,
  keep: (value: string) => boolean,
): [string, string][] {
  const list = raw === undefined ? [] : typeof raw === 'string' ? [raw] : [...raw];
  return [...new Set(list.filter(keep))].slice(0, MAX_FILTER_VALUES).map((v) => [name, v]);
}

function scopePairs(filter: QuotationSummaryFilter): [string, string][] {
  const pairs = repeated('customerId', filter.customerId, (v) => GUID.test(v));
  if (filter.opportunityId !== undefined && GUID.test(filter.opportunityId)) {
    pairs.push(['opportunityId', filter.opportunityId]);
  }
  const q = filter.q?.trim();
  if (q) pairs.push(['q', q]);
  return pairs;
}

function queryOf(pairs: [string, string][]): string {
  const query = new URLSearchParams();
  for (const [name, value] of pairs) query.append(name, value);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

function listPairs(filter: QuotationListFilter): [string, string][] {
  const pairs = [
    ...repeated('status', filter.status, (v) =>
      (QUOTATION_STATUSES as readonly string[]).includes(v),
    ),
    ...scopePairs(filter),
  ];
  if (filter.limit !== undefined)
    pairs.push(['limit', String(Math.max(1, Math.floor(filter.limit)))]);
  if (filter.offset !== undefined) {
    pairs.push(['offset', String(Math.max(0, Math.floor(filter.offset)))]);
  }
  return pairs;
}

/**
 * `GET /v1/quotations`: a bare array of list rows. For callers that want every row of a narrow filter
 * (a picker, one opportunity's quotations): no `limit` is sent unless the caller gives one, and the API
 * then returns every match. The list screen uses `listQuotationsPage`. The API still limits the rows to
 * what the caller may read.
 */
export function listQuotations(
  session: Session,
  filter: QuotationListFilter = {},
): Promise<QuotationListItem[]> {
  return get(
    session,
    `/v1/quotations${queryOf(listPairs(filter))}`,
    z.array(QuotationListItemSchema),
  );
}

/** A page's window is always explicit: the API returns every match when `limit` is absent. */
export type QuotationPageFilter = QuotationListFilter & { limit: number; offset: number };

/** One page of `GET /v1/quotations` with the number of all matches (the `X-Total-Count` header). */
export async function listQuotationsPage(
  session: Session,
  filter: QuotationPageFilter,
): Promise<{ items: QuotationListItem[]; total: number }> {
  const { data, res } = await read(
    session,
    `/v1/quotations${queryOf(listPairs(filter))}`,
    z.array(QuotationListItemSchema),
  );
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : Number.NaN;
  // A missing or malformed count would silently render a wrong pager, so it fails like a contract drift.
  if (!Number.isSafeInteger(total)) {
    throw new ApiError(502, 'GET /v1/quotations returned no valid X-Total-Count', header);
  }
  return { items: data, total };
}

/**
 * `GET /v1/quotations/summary`: counts per current-version status for the same search, customers and
 * opportunity, whatever status is picked. Never sends status or paging (the API refuses them).
 */
export function getQuotationsSummary(
  session: Session,
  filter: QuotationSummaryFilter = {},
): Promise<QuotationSummary> {
  return get(
    session,
    `/v1/quotations/summary${queryOf(scopePairs(filter))}`,
    QuotationSummarySchema,
  );
}

/**
 * `GET /v1/quotations/:id`: the parent, every version, the status history and the contacts, plus the
 * lifecycle fields the contract does not describe yet (`lifecycle-contract.ts`), read from the same body.
 */
export async function getQuotation(
  session: Session,
  id: string,
): Promise<QuotationDetailWithLifecycle> {
  const { data, body } = await read(session, `/v1/quotations/${seg(id)}`, QuotationDetailSchema);
  return { ...data, lifecycle: readLifecycle(body) };
}

/**
 * Where the evidence of an accepted version stands (F1-Q28), or null when the platform has none to show:
 * no acceptance, out of scope (404), or an API without the evidence step yet. Any other failure is null too,
 * so a failed read leaves out the evidence row instead of breaking the quotation page.
 */
export async function getEvidence(
  session: Session,
  quotationId: string,
  versionId: string,
): Promise<QuotationEvidence | null> {
  try {
    return await get(
      session,
      lifecyclePaths.evidence(quotationId, versionId),
      QuotationEvidenceSchema,
    );
  } catch {
    return null;
  }
}
