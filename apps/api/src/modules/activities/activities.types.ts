// Query and mapping types of the activities module. The create body and the DTO are contracts; the list query
// (one optional subject filter, a kind, a status and a limit), the planned rule and the row-to-DTO mapping live here.
import {
  ACTIVITY_SUBJECT_KEYS,
  ActivityKindSchema,
  ActivityStatusSchema,
  SCHEDULABLE_ACTIVITY_KINDS,
  type ActivityDto,
  type Permission,
} from '@bos/contracts';
import { activities, leads } from '@bos/db';
import { and, eq, inArray, isNotNull, isNull, min, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

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
 * The one definition of a planned activity (D39): a call, meeting or email that has a due time and is neither
 * completed nor cancelled. Everything else that is not cancelled is logged: an old note, system or stage_change row
 * that carries a due_at is never a follow-up. `planned` is never stored; queries use this and the mapper below
 * mirrors it. Never NULL, so `not(isPlannedSql)` is safe.
 */
export const isPlannedSql: SQL = and(
  inArray(activities.kind, [...SCHEDULABLE_ACTIVITY_KINDS]),
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
 * `GET /v1/activities?leadId&opportunityId&customerId&contactId&quotationId&kind&status&limit`. At most one
 * subject filter: with none, the list is every activity whose subject the caller may read (the workspace's
 * activity page). `status` picks planned or logged; without it, every activity that is not cancelled. `limit`
 * arrives as text in a query string, so it is coerced.
 */
export const ListActivitiesQuerySchema = z
  .object({
    leadId: z.guid().optional(),
    opportunityId: z.guid().optional(),
    customerId: z.guid().optional(),
    contactId: z.guid().optional(),
    quotationId: z.guid().optional(),
    kind: ActivityKindSchema.optional(),
    status: ActivityStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((q) => ACTIVITY_SUBJECT_KEYS.filter((k) => q[k] !== undefined).length <= 1, {
    path: ['leadId'],
    message: 'at most one of leadId, opportunityId, customerId, contactId or quotationId',
  });
export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuerySchema>;

export type ActivityRow = typeof activities.$inferSelect;

/** Mirrors isPlannedSql on a row already read. */
export const isPlannedRow = (
  row: Pick<ActivityRow, 'kind' | 'dueAt' | 'completedAt' | 'cancelledAt'>,
): boolean =>
  (SCHEDULABLE_ACTIVITY_KINDS as readonly string[]).includes(row.kind) &&
  row.dueAt !== null &&
  row.completedAt === null &&
  row.cancelledAt === null;

export function toActivityDto(row: ActivityRow): ActivityDto {
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
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    planned: isPlannedRow(row),
    createdByUserId: row.createdByUserId,
    occurredAt: row.occurredAt.toISOString(),
    version: row.version,
  };
}
