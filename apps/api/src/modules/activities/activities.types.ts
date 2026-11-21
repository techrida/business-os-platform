// Query and mapping types of the activities module. The create body and the DTO are contracts; the list query
// (one optional subject filter, kinds, a status, a search and a page), the planned rule and the row-to-DTO mapping live here.
import {
  ACTIVITY_SUBJECT_KEYS,
  ActivityKindSchema,
  ActivityStatusSchema,
  limitOffset,
  multi,
  SCHEDULABLE_ACTIVITY_KINDS,
  searchParam,
  type ActivityCan,
  type ActivityDto,
  type ActivityKind,
  type Permission,
} from '@bos/contracts';
import { activities, leads } from '@bos/db';
import { and, eq, inArray, isNotNull, isNull, min, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import type { Db, DbTransaction } from '../../platform/db/db.module';
import { nameIn, personNameMap } from '../../platform/users/person-names';

export type SubjectKey = (typeof ACTIVITY_SUBJECT_KEYS)[number];

/**
 * The permission an activity takes from its subject: reading a lead's activities needs `crm.lead.read`, logging
 * one needs `crm.lead.write`. A quotation has no single write key; drafting is the lowest quotation write.
 */
export const SUBJECT_PERMISSION: Record<SubjectKey, { read: Permission; write: Permission }> = {
  leadId: { read: 'crm.lead.read', write: 'crm.lead.write' },
  opportunityId: { read: 'crm.opportunity.read', write: 'crm.opportunity.write' },
  customerId: { read: 'customer.read', write: 'customer.write' },
  contactId: { read: 'customer.read', write: 'customer.write' },
  quotationId: { read: 'quotation.read', write: 'quotation.draft' },
};

/**
 * The call the payment-promise job plans for Finance (0154, R4c1 Q1). Nobody posts it (it is not a user or
 * schedulable kind); it is read with `ar.read` and completed, moved or cancelled with `payment.record`, never through
 * the customer's activity reach, so the customer's Sales owner neither sees nor cancels it.
 */
export const COLLECTION_CALL_KIND = 'collection_call' satisfies ActivityKind;
export const COLLECTION_CALL_READ: Permission = 'ar.read';
export const COLLECTION_CALL_CHANGE: Permission = 'payment.record';

/** The kinds a follow-up can be: what a person plans, and the collection call the job plans. */
const PLANNED_KINDS: readonly ActivityKind[] = [
  ...SCHEDULABLE_ACTIVITY_KINDS,
  COLLECTION_CALL_KIND,
];

/**
 * The one definition of a planned activity (D39): a call, meeting, email or collection call that has a due time and
 * is neither completed nor cancelled. Everything else that is not cancelled is logged: an old note, system or stage_change row
 * that carries a due_at is never a follow-up. `planned` is never stored; queries use this and the mapper below
 * mirrors it. Never NULL, so `not(isPlannedSql)` is safe.
 */
export const isPlannedSql: SQL = and(
  inArray(activities.kind, [...PLANNED_KINDS]),
  isNotNull(activities.dueAt),
  isNull(activities.completedAt),
  isNull(activities.cancelledAt),
)!;

/**
 * A lead's next follow-up: the earliest due time of its planned activities, or null. A correlated subquery on the
 * outer query's `leads` row, usable as a select field, a filter or a sort key (`LeadDto.nextFollowUpAt`, the
 * lead list). Every column sits inside an operator so Drizzle keeps the table qualifiers the correlation needs.
 */
export function nextFollowUpSql(): SQL<Date | null> {
  return sql<Date | null>`(select ${min(activities.dueAt)} from ${activities} where ${and(
    eq(activities.tenantId, leads.tenantId),
    eq(activities.organizationId, leads.organizationId),
    eq(activities.leadId, leads.id),
    isPlannedSql,
  )})`.mapWith(activities.dueAt);
}

/**
 * `GET /v1/activities?leadId&opportunityId&customerId&contactId&quotationId&kind&status&dueFrom&dueTo&q&limit&offset`.
 * At most one subject filter: with none, the list is every activity whose subject the caller may read (the
 * workspace's activity page). `kind` may repeat. `status` picks planned or logged; without it, every activity that
 * is not cancelled. `dueFrom` and `dueTo` are calendar days in Asia/Kathmandu, both inclusive; either one keeps
 * only activities with a due time. `limit` arrives as text in a query string, so it is coerced.
 */
export const ListActivitiesQuerySchema = z
  .strictObject({
    leadId: z.guid().optional(),
    opportunityId: z.guid().optional(),
    customerId: z.guid().optional(),
    contactId: z.guid().optional(),
    quotationId: z.guid().optional(),
    kind: multi(ActivityKindSchema),
    status: ActivityStatusSchema.optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
    q: searchParam,
    ...limitOffset({ max: 200, fallback: 50 }),
  })
  .refine((q) => ACTIVITY_SUBJECT_KEYS.filter((k) => q[k] !== undefined).length <= 1, {
    path: ['leadId'],
    message: 'at most one of leadId, opportunityId, customerId, contactId or quotationId',
  })
  .refine((q) => q.dueFrom === undefined || q.dueTo === undefined || q.dueFrom <= q.dueTo, {
    path: ['dueFrom'],
    message: 'dueFrom must not be after dueTo',
  });
export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuerySchema>;

/** Asia/Kathmandu is UTC+5:45 all year (no daylight saving), the zone the workspace shows due times in. */
const KATHMANDU_OFFSET = '+05:45';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instants a due-day range covers: from the start of `dueFrom` to before the start of the day after `dueTo`,
 * both in Asia/Kathmandu. Half-open at the top, so a follow-up due at 23:59 on `dueTo` is in.
 */
export function dueRangeBounds(range: {
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
}): {
  from?: Date;
  before?: Date;
} {
  const dayStart = (day: string) => new Date(`${day}T00:00:00${KATHMANDU_OFFSET}`);
  return {
    ...(range.dueFrom !== undefined ? { from: dayStart(range.dueFrom) } : {}),
    ...(range.dueTo !== undefined
      ? { before: new Date(dayStart(range.dueTo).getTime() + DAY_MS) }
      : {}),
  };
}

export type ActivityRow = typeof activities.$inferSelect;

/** Mirrors isPlannedSql on a row already read. */
export const isPlannedRow = (
  row: Pick<ActivityRow, 'kind' | 'dueAt' | 'completedAt' | 'cancelledAt'>,
): boolean =>
  PLANNED_KINDS.includes(row.kind) &&
  row.dueAt !== null &&
  row.completedAt === null &&
  row.cancelledAt === null;

/**
 * `names` holds the display names (D46) of the row's assignee and author, looked up by the caller in the row's
 * tenant (`activityNames`); a person it does not hold reads "Unnamed user", a row without one reads null. `can` is the
 * caller's actions on the row (activity-can.ts), sent on list rows only.
 */
export function toActivityDto(
  row: ActivityRow,
  names: ReadonlyMap<string, string>,
  can?: ActivityCan,
): ActivityDto {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    leadId: row.leadId,
    opportunityId: row.opportunityId,
    customerId: row.customerId,
    contactId: row.contactId,
    quotationId: row.quotationId,
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
    assigneeUserId: row.assigneeUserId,
    assigneeName: nameIn(names, row.assigneeUserId),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    planned: isPlannedRow(row),
    createdByUserId: row.createdByUserId,
    createdByName: nameIn(names, row.createdByUserId),
    occurredAt: row.occurredAt.toISOString(),
    version: row.version,
    ...(can === undefined ? {} : { can }),
  };
}

/** The display names of the people on these rows (assignee and author), one query in the rows' tenant (D46). */
export async function activityNames(
  q: Db | DbTransaction,
  tenantId: string,
  rows: readonly Pick<ActivityRow, 'assigneeUserId' | 'createdByUserId'>[],
): Promise<ReadonlyMap<string, string>> {
  return personNameMap(
    q,
    tenantId,
    rows.flatMap((r) => [r.assigneeUserId, r.createdByUserId]),
  );
}
