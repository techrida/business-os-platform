// Query and mapping types of the activities module. The create body and the DTO are contracts; the list query
// (one optional subject filter, kinds, a search and a page) and the row-to-DTO mapping live here.
import {
  ACTIVITY_SUBJECT_KEYS,
  ActivityKindSchema,
  limitOffset,
  multi,
  searchParam,
  type ActivityDto,
  type Permission,
} from '@bos/contracts';
import { type activities } from '@bos/db';
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
 * `GET /v1/activities?leadId&opportunityId&customerId&contactId&quotationId&kind&q&limit&offset`. At most one
 * subject filter: with none, the list is every activity whose subject the caller may read (the workspace's
 * activity page). `kind` may repeat. `limit` arrives as text in a query string, so it is coerced.
 */
export const ListActivitiesQuerySchema = z
  .strictObject({
    leadId: z.guid().optional(),
    opportunityId: z.guid().optional(),
    customerId: z.guid().optional(),
    contactId: z.guid().optional(),
    quotationId: z.guid().optional(),
    kind: multi(ActivityKindSchema),
    q: searchParam,
    ...limitOffset({ max: 200, fallback: 50 }),
  })
  .refine((q) => ACTIVITY_SUBJECT_KEYS.filter((k) => q[k] !== undefined).length <= 1, {
    path: ['leadId'],
    message: 'at most one of leadId, opportunityId, customerId, contactId or quotationId',
  });
export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuerySchema>;

export type ActivityRow = typeof activities.$inferSelect;

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
    occurredAt: row.occurredAt.toISOString(),
  };
}
