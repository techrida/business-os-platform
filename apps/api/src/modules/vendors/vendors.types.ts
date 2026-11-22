// Request and response shapes that only the vendors routes use. The create body, the vendor and account DTOs and
// the contact body live in @bos/contracts (vendors.ts); what that file does not define is local here: the list
// query, the PATCH bodies, the lifecycle reason, the contact view and the account create body.
import {
  AddressLinesSchema,
  CountryCodeSchema,
  CurrencySchema,
  EmailSchema,
  limitOffset,
  multi,
  PanVatNoSchema,
  PartyPhonesSchema,
  searchParam,
  VendorKindSchema,
  VendorStatusSchema,
  type VendorDto,
} from '@bos/contracts';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
/**
 * GET /v1/vendors?q&status&kind&limit&offset. `status` and `kind` may repeat (`?status=approved&status=draft`):
 * values of one filter are OR-ed, filters are AND-ed. An unknown value or key is a 400.
 */
export const ListVendorsQuerySchema = z.strictObject({
  q: searchParam,
  status: multi(VendorStatusSchema),
  kind: multi(VendorKindSchema),
  ...limitOffset({ max: 100, fallback: 50 }),
});
export type ListVendorsQuery = z.infer<typeof ListVendorsQuerySchema>;

export interface VendorList {
  items: VendorDto[];
  total: number;
}

/**
 * PATCH /v1/vendors/:id. The kind and the country are fixed at create (the foreign rule ties them together), so
 * they are not here. `legalName` and `pan` also lock once the vendor is approved: a change of tax identity goes
 * through a new KYB review, not an edit. The PAN has the loose shape here; the service holds a Nepal vendor to nine
 * digits against its stored country (FX9). `address` replaces both lines and city, and `null` clears them.
 */
export const UpdateVendorBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  legalName: text(200).optional(),
  pan: PanVatNoSchema.optional(),
  address: AddressLinesSchema.nullable().optional(),
  vatRegistered: z.boolean().optional(),
  ownerUserId: z.guid().optional(),
});
export type UpdateVendorBody = z.infer<typeof UpdateVendorBodySchema>;

/**
 * POST /v1/vendors/:id/submit-kyc. `expectedStatus` is the status the caller's button was drawn for; a different
 * current status is a 409, so a stale button never runs the other move of this endpoint. Optional for callers that
 * send no body.
 */
export const SubmitKycBodySchema = z.strictObject({
  expectedStatus: VendorStatusSchema.optional(),
});
export type SubmitKycBody = z.infer<typeof SubmitKycBodySchema>;

/**
 * GET /v1/vendors/name-matches?legalName=: the vendors whose legal name matches the one being added once case,
 * spaces, punctuation and company-form words are ignored (TR-Q12d). A warning only: creating is never refused.
 */
export const VendorNameMatchesQuerySchema = z.strictObject({ legalName: text(200) });
export type VendorNameMatchesQuery = z.infer<typeof VendorNameMatchesQuerySchema>;

export const VendorNameMatchSchema = z.strictObject({
  id: z.guid(),
  legalName: z.string(),
  status: VendorStatusSchema,
});
export interface VendorNameMatches {
  matches: z.infer<typeof VendorNameMatchSchema>[];
}

/**
 * GET /v1/vendors/:id/review-readiness: whether the vendor's KYB case is submitted (or approved), the state
 * `submit-kyc` checks before pending_kyc -> under_review. The screens draw "Send for review" only when it is true.
 */
export const VendorReviewReadinessSchema = z.strictObject({ kybSubmitted: z.boolean() });
export type VendorReviewReadiness = z.infer<typeof VendorReviewReadinessSchema>;

/** Body of suspend, block and archive: why, for the audit trail (the table has no reason column). */
export const VendorReasonBodySchema = z.strictObject({ reason: text(500) });
export type VendorReasonBody = z.infer<typeof VendorReasonBodySchema>;

/**
 * A contact as the API returns it: the contract defines only the request body. `phones` lists the primary first,
 * then the rest in the order they were sent (FX9).
 */
export const VendorContactDtoSchema = z.strictObject({
  id: z.guid(),
  vendorPartyId: z.guid(),
  name: z.string(),
  email: z.string().nullable(),
  country: CountryCodeSchema,
  phones: PartyPhonesSchema,
  role: z.string().nullable(),
  isPrimary: z.boolean(),
  version: z.number().int().min(1),
});
export type VendorContactDto = z.infer<typeof VendorContactDtoSchema>;

/**
 * PATCH /v1/vendors/:id/contacts/:contactId. Only the keys sent change; `null` clears an optional field. `phones`,
 * when sent, replaces the contact's whole list (`[]` removes every number); it has no default, so an edit that
 * leaves it out keeps the stored numbers.
 */
export const UpdateVendorContactBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  name: text(120).optional(),
  email: EmailSchema.nullable().optional(),
  country: CountryCodeSchema.optional(),
  phones: PartyPhonesSchema.optional(),
  role: text(80).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type UpdateVendorContactBody = z.infer<typeof UpdateVendorContactBodySchema>;

/**
 * POST /v1/vendors/:id/accounts: the vendor's terms with a legal entity of the tenant (default: the acting one).
 * The contract has only the DTO. A term is a `payment_terms` row of the tenant; the currency is NPR when omitted.
 */
export const CreateVendorAccountBodySchema = z.strictObject({
  organizationId: z.guid().optional(),
  paymentTermId: z.guid().optional(),
  defaultCurrency: CurrencySchema.optional(),
});
export type CreateVendorAccountBody = z.infer<typeof CreateVendorAccountBodySchema>;
