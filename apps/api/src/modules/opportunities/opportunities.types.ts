// Query and mapping types of the opportunities module. The body of a stage change is a contract
// (OpportunityStageChangeBodySchema); only the list query and the row-to-DTO mapping live here.
import {
  limitOffset,
  multi,
  type OpportunityDto,
  OpportunityStageSchema,
  searchParam,
} from '@bos/contracts';
import { type opportunities } from '@bos/db';
import { z } from 'zod';

/**
 * `GET /v1/opportunities?q&stage&owner&limit&offset`. `stage` and `owner` may repeat (any of the selected values
 * matches). The board view asks for up to 200 rows at once, so the cap stays at 200 and the default at 50.
 */
export const ListOpportunitiesQuerySchema = z.strictObject({
  q: searchParam,
  stage: multi(OpportunityStageSchema),
  owner: multi(z.guid()),
  ...limitOffset({ max: 200, fallback: 50 }),
});
export type ListOpportunitiesQuery = z.infer<typeof ListOpportunitiesQuerySchema>;

export type OpportunityRow = typeof opportunities.$inferSelect;

/** `ownerName` is the owner's display name (D46), looked up by the caller; null without an owner. */
export function toOpportunityDto(row: OpportunityRow, ownerName: string | null): OpportunityDto {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    customerId: row.customerId,
    contactId: row.contactId,
    leadId: row.leadId,
    ownerUserId: row.ownerUserId,
    ownerName,
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
