// Query and mapping types of the opportunities module. The body of a stage change is a contract
// (OpportunityStageChangeBodySchema); only the list query and the row-to-DTO mapping live here.
import { OPPORTUNITY_STAGES, type OpportunityDto, OpportunityStageSchema } from '@bos/contracts';
import { type opportunities } from '@bos/db';
import { z } from 'zod';

/** Repeat `stage` to match any selected stage, up to the number of supported stages. */
export const ListOpportunitiesQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  stage: z
    .union([
      OpportunityStageSchema,
      z.array(OpportunityStageSchema).min(1).max(OPPORTUNITY_STAGES.length),
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListOpportunitiesQuery = z.infer<typeof ListOpportunitiesQuerySchema>;

export type OpportunityRow = typeof opportunities.$inferSelect;

export function toOpportunityDto(row: OpportunityRow): OpportunityDto {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    customerId: row.customerId,
    contactId: row.contactId,
    leadId: row.leadId,
    ownerUserId: row.ownerUserId,
    stage: row.stage,
    stageReason: row.stageReason,
    stageNote: row.stageNote,
    value: row.value,
    currency: row.currency as OpportunityDto['currency'],
    probability: row.probability,
    expectedClose: row.expectedClose,
    wonQuotationVersionId: row.wonQuotationVersionId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
