// Query and mapping types of the leads module. The bodies (create, edit, stage change) are contracts; only the list
// query, the row-to-DTO mapping and the edit's field diff live here.
import {
  type LeadDto,
  type LeadLostReasonRef,
  LeadStageSchema,
  type UpdateLeadBody,
} from '@bos/contracts';
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

/** The edit body's fields, without the version. */
type LeadEditFields = Omit<UpdateLeadBody, 'expectedVersion'>;
type LeadField = keyof LeadEditFields;
type LeadColumn = keyof typeof leads.$inferInsert;

/** Body field to column. `email` and `phone` are stored normalised under other names. */
const EDITABLE: Record<LeadField, LeadColumn> = {
  title: 'title',
  source: 'source',
  campaign: 'campaign',
  ownerUserId: 'ownerUserId',
  companyName: 'companyName',
  contactName: 'contactName',
  email: 'emailNorm',
  phone: 'phoneE164',
  requirement: 'requirement',
  expectedValue: 'expectedValue',
  currency: 'currency',
  probability: 'probability',
  expectedClose: 'expectedClose',
  notes: 'notes',
};

/** "1000", "1000.0" and "1000.00" are one amount; numeric(18,2) reads back with two decimals. */
const decimalKey = (s: string): string =>
  s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

export interface LeadFieldChange {
  field: LeadField;
  column: LeadColumn;
  before: unknown;
  after: unknown;
}

/**
 * The fields of an edit that differ from the row, in body terms (`field`, for the audit) and row terms (`column`,
 * for the update). A field left out of the body never changes; the email is normalised like create does.
 */
export function changedLeadFields(row: LeadRow, body: LeadEditFields): LeadFieldChange[] {
  const changes: LeadFieldChange[] = [];
  for (const field of Object.keys(EDITABLE) as LeadField[]) {
    const sent = body[field];
    if (sent === undefined) continue;
    const column = EDITABLE[field];
    const after = field === 'email' ? String(sent).trim().toLowerCase() : sent;
    const before = row[column];
    const same =
      field === 'expectedValue' && typeof before === 'string'
        ? decimalKey(before) === decimalKey(String(after))
        : before === after;
    if (!same) changes.push({ field, column, before, after });
  }
  return changes;
}

/**
 * `nextFollowUp` is derived, never read from the row: the earliest due time of the lead's planned activities (D39,
 * `nextFollowUpSql()` in activities.types.ts). The `leads.next_follow_up_at` column stays for rollback only and is
 * neither written nor read. Required, so a caller that forgets the derived value does not compile.
 * `ownerName` is the owner's display name (D46), looked up by the caller under the lead's own read permission.
 * `lostReason` is the lost reason option's current label (D49); null unless the lead was lost with an option.
 */
export function toLeadDto(
  row: LeadRow,
  nextFollowUp: Date | null,
  ownerName: string | null,
  lostReason: LeadLostReasonRef | null,
): LeadDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    source: row.source,
    campaign: row.campaign,
    ownerUserId: row.ownerUserId,
    ownerName,
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
    nextFollowUpAt: nextFollowUp === null ? null : nextFollowUp.toISOString(),
    stage: row.stage,
    stageReason: row.stageReason,
    lostReason,
    stageNote: row.stageNote,
    convertedOpportunityId: row.convertedOpportunityId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
