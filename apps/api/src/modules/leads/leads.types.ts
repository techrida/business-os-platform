// Query and mapping types of the leads module. The bodies (create, edit, stage change) are contracts; only the list
// query, the row-to-DTO mapping and the edit's field diff live here.
import {
  type AddressLines,
  type LeadDto,
  type LeadLostReasonRef,
  limitOffset,
  LeadSourceSchema,
  type LeadStage,
  LeadStageSchema,
  multi,
  type PartyPhone,
  searchParam,
  type UpdateLeadBody,
} from '@bos/contracts';
import { type leads } from '@bos/db';
import { z } from 'zod';

import { can, type Principal } from '../../platform/authz/can';
import { allowedLeadMoves, leadRef } from './lead-stage';

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

/**
 * `GET /v1/leads/owners?context`: whom the caller may hand a lead to. `reassign` (the default) is the owner select of
 * a lead that exists; `create` is the new-lead form, where Finance, Accountant and PMO pick a Sales owner.
 */
export const LeadOwnersQuerySchema = z.strictObject({
  context: z.enum(['create', 'reassign']).default('reassign'),
});
export type LeadOwnersQuery = z.infer<typeof LeadOwnersQuerySchema>;

/** Every stage is present, zero when empty, so the cards never depend on which stages the data has. */
export interface LeadSummary {
  total: number;
  byStage: Record<LeadStage, number>;
}

export type LeadRow = typeof leads.$inferSelect;

/** The edit body's fields, without the version. */
type LeadEditFields = Omit<UpdateLeadBody, 'expectedVersion' | 'customerId' | 'contactId'>;
/**
 * The fields stored on the lead row, one column each; `phones` are rows of their own (lead-phones.ts) and `address`
 * is two columns (`addressChange`), both diffed by the service.
 */
type LeadField = Exclude<keyof LeadEditFields, 'phones' | 'address'>;
type LeadColumn = keyof typeof leads.$inferInsert;

/** Body field to column. `email` is stored normalised under another name. */
const EDITABLE: Record<LeadField, LeadColumn> = {
  title: 'title',
  source: 'source',
  campaign: 'campaign',
  ownerUserId: 'ownerUserId',
  companyName: 'companyName',
  contactName: 'contactName',
  country: 'country',
  email: 'emailNorm',
  requirement: 'requirement',
  expectedValue: 'expectedValue',
  currency: 'currency',
  probability: 'probability',
  expectedClose: 'expectedClose',
  notes: 'notes',
};

/** "1000", "1000.0" and "1000.00" are one amount; numeric(18,2) reads back with two decimals. */
const decimalKey = (s: string): string => {
  if (!s.includes('.')) return s;
  let end = s.length;
  while (end > 0 && s[end - 1] === '0') end -= 1;
  if (end > 0 && s[end - 1] === '.') end -= 1;
  return s.slice(0, end);
};

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
export function changedLeadFields(
  row: LeadRow,
  body: Omit<LeadEditFields, 'phones' | 'address'>,
): LeadFieldChange[] {
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

/** The lead's address as the DTO carries it: both columns, or null when it has none (0199 keeps them together). */
export function addressOfLead(row: {
  addressLine: string | null;
  addressCity: string | null;
}): AddressLines | null {
  return row.addressLine === null || row.addressCity === null
    ? null
    : { line: row.addressLine, city: row.addressCity };
}

/** The address columns for `address`: both set, or both null (`leads_address_check`). */
export function addressColumnsOf(address: AddressLines | null | undefined): {
  addressLine: string | null;
  addressCity: string | null;
} {
  return address === null || address === undefined
    ? { addressLine: null, addressCity: null }
    : { addressLine: address.line, addressCity: address.city };
}

/**
 * The address edit of an update, or undefined when the body leaves the address out or sends what is stored. `null`
 * clears it. `before` and `after` are the DTO shapes, for the audit.
 */
export function addressChange(
  row: LeadRow,
  sent: AddressLines | null | undefined,
):
  | {
      before: AddressLines | null;
      after: AddressLines | null;
      columns: ReturnType<typeof addressColumnsOf>;
    }
  | undefined {
  if (sent === undefined) return undefined;
  const before = addressOfLead(row);
  if (
    before === null
      ? sent === null
      : sent !== null && before.line === sent.line && before.city === sent.city
  ) {
    return undefined;
  }
  return { before, after: sent, columns: addressColumnsOf(sent) };
}

/**
 * `nextFollowUp` is derived, never read from the row: the earliest due time of the lead's planned activities (D39,
 * `nextFollowUpSql()` in activities.types.ts). The `leads.next_follow_up_at` column stays for rollback only and is
 * neither written nor read. Required, so a caller that forgets the derived value does not compile.
 * `ownerName` is the owner's display name (D46), looked up by the caller under the lead's own read permission.
 * `lostReason` is the lost reason option's current label (D49); null unless the lead was lost with an option.
 * `phones` are the lead person's numbers as `loadLeadPhones` returns them (primary first, then saved order).
 */
export function toLeadDto(
  row: LeadRow,
  nextFollowUp: Date | null,
  ownerName: string | null,
  lostReason: LeadLostReasonRef | null,
  phones: PartyPhone[],
  principal?: Principal,
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
    country: row.country as LeadDto['country'],
    address: addressOfLead(row),
    email: row.emailNorm,
    phones,
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
    heldFromStage: row.heldFromStage,
    ...(principal === undefined
      ? {}
      : {
          allowedMoves: allowedLeadMoves(principal, row),
          canEdit: can(principal, 'crm.lead.write', leadRef(row)).allowed,
        }),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
