import 'server-only';

import {
  type ActivityKind,
  type ActivityStatus,
  ActivityDtoSchema,
  type CancelActivityBody,
  type CompleteActivityBody,
  type ConvertLeadBody,
  CreditHoldDtoSchema,
  type CreditOverrideBody,
  type CreateActivityBody,
  type CreateLeadBody,
  type LeadStageChangeBody,
  LeadDtoSchema,
  LeadOwnerOptionSchema,
  type RescheduleActivityBody,
  type UpdateLeadBody,
  type OpportunityOwnerChangeBody,
  type OpportunityStage,
  type OpportunityStageChangeBody,
  OpportunityDtoSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/**
 * Typed calls from the workspace BFF to the CRM routes. Every response is parsed with the
 * contracts' schemas, so an API that drifts fails loudly (502) instead of rendering `undefined`.
 * Lists answer a bare array today; the envelope is read in one place (`listOf`).
 */

/** A list answers a bare array (the API's CRM lists do); `{ items }` is accepted too. */
const listOf = <T extends z.ZodType>(item: T) =>
  z.union([z.array(item), z.object({ items: z.array(item) }).transform((o) => o.items)]);

/** A successful convert answers `{ opportunityId, customerId }`. */
const ConvertResultSchema = z.object({
  opportunityId: z.guid(),
  customerId: z.guid().optional(),
});
export type ConvertResult = z.infer<typeof ConvertResultSchema>;

const seg = (id: string): string => encodeURIComponent(id);

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function call<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(session, path, init);
  const body = await readBody(res);
  const label = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function query(params: Record<string, string | number | readonly string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'object') {
      for (const item of value) q.append(key, item);
    } else {
      q.set(key, String(value));
    }
  }
  return q.size > 0 ? `?${q.toString()}` : '';
}

// ---------------------------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------------------------

export function listLeads(
  session: Session,
  opts: { stage?: string; q?: string; limit?: number } = {},
) {
  return call(session, `/v1/leads${query(opts)}`, listOf(LeadDtoSchema));
}

export function getLead(session: Session, id: string) {
  return call(session, `/v1/leads/${seg(id)}`, LeadDtoSchema);
}

/**
 * The API dedupes on the `idempotency-key` header, so a double click or a retry after a timeout
 * creates one lead, not two.
 */
export function createLead(session: Session, body: CreateLeadBody, idempotencyKey: string) {
  return call(
    session,
    '/v1/leads',
    LeadDtoSchema,
    json('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}

/**
 * People the caller may hand a lead (or its follow-up) to. A caller with `own` scope gets only
 * themselves, so the select then has one option.
 */
export function listLeadOwners(session: Session, context?: 'create' | 'reassign') {
  const suffix = context === undefined ? '' : `?context=${context}`;
  return call(session, `/v1/leads/owners${suffix}`, listOf(LeadOwnerOptionSchema));
}

/**
 * The Owner filter's people for the leads or opportunities list: the owners of records the caller may read plus the
 * people they may hand one to (`GET /v1/<area>/owner-filter`). Open to everyone who can read the list, unlike the
 * admin user directory. A failed read leaves the filter out rather than blocking the list.
 */
export async function ownerFilterNames(
  session: Session,
  area: 'leads' | 'opportunities',
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const o of await call(
      session,
      `/v1/${area}/owner-filter`,
      listOf(LeadOwnerOptionSchema),
    )) {
      names.set(o.userId, o.displayName.trim() || 'Unnamed user');
    }
  } catch {
    // Names are a courtesy; the list still loads without the Owner control.
  }
  return names;
}

/** Edit the lead's own fields (today: the owner). Answers the updated lead; 409 when stale. */
export function updateLead(session: Session, id: string, body: UpdateLeadBody) {
  return call(session, `/v1/leads/${seg(id)}`, LeadDtoSchema, json('PATCH', body));
}

/** The stage route answers the updated lead. */
export function changeLeadStage(session: Session, id: string, body: LeadStageChangeBody) {
  return call(session, `/v1/leads/${seg(id)}/stage`, LeadDtoSchema, json('PATCH', body));
}

/**
 * Convert a qualified lead. The idempotency key is made when the dialog opens, so a retry after a
 * timeout is the same request and cannot create the customer twice. A duplicate warning arrives as
 * an `ApiError` whose `body` `duplicatesFrom` reads.
 */
export function convertLead(
  session: Session,
  id: string,
  body: ConvertLeadBody,
  idempotencyKey: string,
) {
  return call(
    session,
    `/v1/leads/${seg(id)}/convert`,
    ConvertResultSchema,
    json('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}

// ---------------------------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------------------------

/** An empty stage selection omits the filter. Each selected stage becomes a `stage` parameter. */
export function listOpportunities(
  session: Session,
  opts: { stage?: string | readonly OpportunityStage[]; q?: string; limit?: number } = {},
) {
  return call(session, `/v1/opportunities${query(opts)}`, listOf(OpportunityDtoSchema));
}

export function getOpportunity(session: Session, id: string) {
  return call(session, `/v1/opportunities/${seg(id)}`, OpportunityDtoSchema);
}

/**
 * Hand a deal to someone else (`PATCH /v1/opportunities/:id/owner`, F1-Q51). Answers the updated
 * opportunity; the owner's open follow-ups on it move to the new owner in the same change.
 */
export function changeOpportunityOwner(
  session: Session,
  id: string,
  body: OpportunityOwnerChangeBody,
) {
  return call(
    session,
    `/v1/opportunities/${seg(id)}/owner`,
    OpportunityDtoSchema,
    json('PATCH', body),
  );
}

/**
 * The people the caller may hand a deal to (`GET /v1/opportunities/owners`): exactly whom the
 * owner PATCH accepts. Emails come back empty, so name people by `displayName`.
 */
export function listOpportunityOwners(session: Session) {
  return call(session, '/v1/opportunities/owners', listOf(LeadOwnerOptionSchema));
}

/**
 * The people a follow-up on a deal may be assigned to (`crm.opportunity.write`): the owner select's rule, but
 * reading opportunities is enough, so a read-only colleague the owner list leaves out can still be given the work.
 * Emails come back empty.
 */
export function listOpportunityFollowUpAssignees(session: Session) {
  return call(session, '/v1/opportunities/follow-up-assignees', listOf(LeadOwnerOptionSchema));
}

/**
 * A deal's credit position (F1-Q20): limit, exposure and any override. Only for `credit.override`
 * holders; anyone else gets 403 and reads the booleans on the deal instead.
 */
export function getCreditHold(session: Session, id: string) {
  return call(session, `/v1/opportunities/${seg(id)}/credit-hold`, CreditHoldDtoSchema);
}

/**
 * Override a deal's credit hold with a reason (`credit.override`), for one quotation version at one order value
 * (R5 FU10): another order on the deal, a new version or a different value needs a new override.
 */
export function overrideCreditHold(session: Session, id: string, body: CreditOverrideBody) {
  return call(
    session,
    `/v1/opportunities/${seg(id)}/credit-override`,
    CreditHoldDtoSchema,
    json('POST', body),
  );
}

/** The stage route answers the updated opportunity. */
export function changeOpportunityStage(
  session: Session,
  id: string,
  body: OpportunityStageChangeBody,
) {
  return call(
    session,
    `/v1/opportunities/${seg(id)}/stage`,
    OpportunityDtoSchema,
    json('PATCH', body),
  );
}

// ---------------------------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------------------------

/**
 * Query params the screens send: one subject id (`leadId` or `opportunityId`), `kind`, `limit`
 * and `status`: `planned` (the Follow-ups card, earliest due first) or `logged` (History, newest
 * first). Without `status` every non-cancelled activity is listed.
 */
export function listActivities(
  session: Session,
  opts: {
    leadId?: string;
    opportunityId?: string;
    kind?: ActivityKind;
    status?: ActivityStatus;
    limit?: number;
  } = {},
) {
  return call(session, `/v1/activities${query(opts)}`, listOf(ActivityDtoSchema));
}

/** Complete a planned follow-up; it becomes a logged activity. Answers the updated activity. */
export function completeActivity(session: Session, id: string, body: CompleteActivityBody) {
  return call(
    session,
    `/v1/activities/${seg(id)}/complete`,
    ActivityDtoSchema,
    json('PATCH', body),
  );
}

export function rescheduleActivity(session: Session, id: string, body: RescheduleActivityBody) {
  return call(
    session,
    `/v1/activities/${seg(id)}/reschedule`,
    ActivityDtoSchema,
    json('PATCH', body),
  );
}

/** A cancelled follow-up leaves both the Follow-ups card and History. */
export function cancelActivity(session: Session, id: string, body: CancelActivityBody) {
  return call(session, `/v1/activities/${seg(id)}/cancel`, ActivityDtoSchema, json('PATCH', body));
}

/** Sent with an `idempotency-key`, so a double click logs the activity once. */
export function createActivity(session: Session, body: CreateActivityBody, idempotencyKey: string) {
  return call(
    session,
    '/v1/activities',
    ActivityDtoSchema,
    json('POST', body, { 'idempotency-key': idempotencyKey }),
  );
}
