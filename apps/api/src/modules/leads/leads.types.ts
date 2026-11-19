// Query and mapping types of the leads module. The bodies (create, stage change) are contracts; only the list
// query and the row-to-DTO mapping live here.
import {
  type LeadDto,
  limitOffset,
  LeadSourceSchema,
  type LeadStage,
  LeadStageSchema,
  multi,
  searchParam,
} from '@bos/contracts';
import { type leads } from '@bos/db';
import { z } from 'zod';

/**
 * `GET /v1/leads?q&stage&source&ownerUserId&limit&offset`. The three filters may repeat (any selected value
 * matches). The board view asks for up to 200 rows at once, so the cap stays at 200 and the default at 50.
 */
export const ListLeadsQuerySchema = z.strictObject({
  q: searchParam,
  stage: multi(LeadStageSchema),
  source: multi(LeadSourceSchema),
  ownerUserId: multi(z.guid()),
  ...limitOffset({ max: 200, fallback: 50 }),
});
export type ListLeadsQuery = z.infer<typeof ListLeadsQuerySchema>;

/** `GET /v1/leads/summary`: the list filters without `stage` (the cards are the stages) and without paging. */
export const LeadSummaryQuerySchema = z.strictObject({
  q: searchParam,
  source: multi(LeadSourceSchema),
  ownerUserId: multi(z.guid()),
});
export type LeadSummaryQuery = z.infer<typeof LeadSummaryQuerySchema>;

/** Every stage is present, zero when empty, so the cards never depend on which stages the data has. */
export interface LeadSummary {
  total: number;
  byStage: Record<LeadStage, number>;
}

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
