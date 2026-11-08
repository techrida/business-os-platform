// Query and mapping types of the leads module. The bodies (create, stage change) are contracts; only the list
// query and the row-to-DTO mapping live here.
import { type LeadDto, LeadStageSchema } from '@bos/contracts';
import { type leads } from '@bos/db';
import { z } from 'zod';

/** `GET /v1/leads?q&stage&limit`. `limit` arrives as text in a query string, so it is coerced. */
export const ListLeadsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  stage: LeadStageSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLeadsQuery = z.infer<typeof ListLeadsQuerySchema>;

export type LeadRow = typeof leads.$inferSelect;

export function toLeadDto(row: LeadRow): LeadDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    source: row.source,
    campaign: row.campaign,
    ownerUserId: row.ownerUserId,
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.emailNorm,
    phone: row.phoneE164,
    customerId: row.customerId,
    contactId: row.contactId,
    requirement: row.requirement,
    expectedValue: row.expectedValue,
    currency: row.currency as LeadDto['currency'],
    probability: row.probability,
    expectedClose: row.expectedClose,
    nextFollowUpAt: row.nextFollowUpAt === null ? null : row.nextFollowUpAt.toISOString(),
    stage: row.stage,
    stageReason: row.stageReason,
    stageNote: row.stageNote,
    convertedOpportunityId: row.convertedOpportunityId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
