// Contracts for vendor accounts (P4). A vendor is a party of kind `vendor` (ADR 0027), so every id here
// is a `vendorPartyId`. Serves the NFR "a payment goes only to a verified account": a bank account is
// proposed by one person and verified by another, and every DTO shows the last four digits only.
import { z } from 'zod';

import { AddressLinesSchema } from './addresses.js';
import { CountryCodeSchema } from './countries.js';
import { EmailSchema, NepalPanSchema, PanVatNoSchema, nepalPanProblem } from './crm.js';
import { CurrencySchema } from './money.js';
import { PartyPhonesSchema } from './phones.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------------------------
// Vendor state machine (A4 section 2.4)
// ---------------------------------------------------------------------------------------------

export const VENDOR_STATUSES = [
  'draft',
  'pending_kyc',
  'under_review',
  'approved',
  'suspended',
  'blocked',
  'archived',
] as const;
export const VendorStatusSchema = z.enum(VENDOR_STATUSES);
export type VendorStatus = z.infer<typeof VendorStatusSchema>;

/** Allowed moves. The reviewer who approves is not the creator; that rule is enforced by the service, not here. */
export const VENDOR_TRANSITIONS: Readonly<Record<VendorStatus, readonly VendorStatus[]>> = {
  draft: ['pending_kyc'],
  pending_kyc: ['under_review'],
  under_review: ['approved', 'pending_kyc'],
  approved: ['suspended', 'blocked'],
  suspended: ['approved', 'blocked'],
  blocked: ['archived'],
  archived: [],
};

export function canTransitionVendor(from: VendorStatus, to: VendorStatus): boolean {
  return VENDOR_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export const VENDOR_KINDS = ['company', 'sole_proprietor', 'individual', 'foreign'] as const;
export const VendorKindSchema = z.enum(VENDOR_KINDS);
export type VendorKind = z.infer<typeof VendorKindSchema>;

/** The KYC documents a vendor may be asked for; which are required depends on the vendor kind. */
export const VENDOR_KYC_DOC_TYPES = [
  'pan_certificate',
  'vat_certificate',
  'company_registration',
  'tax_clearance',
  'bank_proof',
  'proprietor_citizenship',
  'foreign_registration',
] as const;
export const VendorKycDocTypeSchema = z.enum(VENDOR_KYC_DOC_TYPES);
export type VendorKycDocType = z.infer<typeof VendorKycDocTypeSchema>;

export const VENDOR_KYC_REVIEW_STATUSES = ['submitted', 'accepted', 'rejected', 'expired'] as const;
export const VendorKycReviewStatusSchema = z.enum(VENDOR_KYC_REVIEW_STATUSES);
export type VendorKycReviewStatus = z.infer<typeof VendorKycReviewStatusSchema>;

export const BANK_ACCOUNT_STATUSES = ['proposed', 'active', 'retired', 'rejected'] as const;
export const BankAccountStatusSchema = z.enum(BANK_ACCOUNT_STATUSES);
export type BankAccountStatus = z.infer<typeof BankAccountStatusSchema>;

export const BANK_PROPOSED_VIA = ['portal', 'staff'] as const;
export const BankProposedViaSchema = z.enum(BANK_PROPOSED_VIA);
export type BankProposedVia = z.infer<typeof BankProposedViaSchema>;

/** A resident vendor's PAN: exactly nine digits (GK). */
export const VendorPanSchema = NepalPanSchema;

// ---------------------------------------------------------------------------------------------
// Vendor bodies and views
// ---------------------------------------------------------------------------------------------

/**
 * Create a vendor. Strict, so a client cannot send `status` or `approvedBy`. A foreign vendor may
 * leave the PAN out; every other kind needs it.
 */
export const CreateVendorBodySchema = z
  .strictObject({
    legalName: text(200),
    tradeName: text(200).optional(),
    kind: VendorKindSchema,
    /** A Nepal vendor's PAN is nine digits; a foreign vendor keeps the loose tax-id shape (checked below). */
    pan: PanVatNoSchema.optional(),
    vatRegistered: z.boolean(),
    /** ISO 3166-1 alpha-2, such as NP. The vendor's address country is this one (FX9). */
    country: CountryCodeSchema,
    categoryId: z.guid().optional(),
    /**
     * The street lines and city, or left out. Both or none: `AddressLinesSchema` requires both, so a line without a
     * city (or a city without a line) is refused, and leaving the address out stores neither (the nullable
     * `address_line` and `address_city` columns, held together by `vendors_address_check`).
     */
    address: AddressLinesSchema.optional(),
  })
  .refine((v) => v.kind === 'foreign' || v.pan !== undefined, {
    message: 'a PAN is required unless the vendor is foreign',
    path: ['pan'],
  })
  .superRefine((v, ctx) => {
    const problem = nepalPanProblem(v.country, v.pan);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: ['pan'] });
  });
export type CreateVendorBody = z.infer<typeof CreateVendorBodySchema>;

export const VendorCapabilitiesSchema = z.strictObject({
  write: z.boolean(),
  activate: z.boolean(),
  suspend: z.boolean(),
  block: z.boolean(),
  archive: z.boolean(),
  activateBlockedBySod: z.boolean().optional(),
  activateBlockedByKyb: z.boolean().optional(),
  activateBlockedByKycExpired: z.boolean().optional(),
  proposeBank: z.boolean().optional(),
  verifyBank: z.boolean().optional(),
});
export type VendorCapabilities = z.infer<typeof VendorCapabilitiesSchema>;

export const VendorDtoSchema = z.strictObject({
  /** The party id. */
  id: z.guid(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  kind: VendorKindSchema,
  pan: z.string().nullable(),
  vatRegistered: z.boolean(),
  country: CountryCodeSchema,
  /** The street lines and city; null when the vendor has no address on file. The country is `country`. */
  address: AddressLinesSchema.nullable(),
  status: VendorStatusSchema,
  version: z.number().int().min(1),
  approvedAt: isoDateTime.nullable(),
  /** The vendor's logo (`app.vendors.logo_document_id`); null or absent shows initials. */
  logoDocumentId: z.guid().nullable().optional(),
  can: VendorCapabilitiesSchema.optional(),
});
export type VendorDto = z.infer<typeof VendorDtoSchema>;

/** The vendor's terms with one legal entity (the vendor twin of a customer's party account). */
export const VendorAccountDtoSchema = z.strictObject({
  vendorPartyId: z.guid(),
  organizationId: z.guid(),
  paymentTermsDays: z.number().int().min(0).max(365),
  defaultCurrency: CurrencySchema,
  defaultWithholdingCodeId: z.guid().nullable(),
  active: z.boolean(),
});
export type VendorAccountDto = z.infer<typeof VendorAccountDtoSchema>;

/**
 * A vendor contact. Its country may differ from the vendor's; each phone carries its own country (FX9). `phones`
 * defaults to none.
 */
export const VendorContactBodySchema = z.strictObject({
  name: text(120),
  email: EmailSchema.optional(),
  country: CountryCodeSchema,
  phones: PartyPhonesSchema.default([]),
  role: text(80).optional(),
  isPortalAdmin: z.boolean().default(false),
});
export type VendorContactBody = z.infer<typeof VendorContactBodySchema>;

/** Staff record a KYC document. `validUntil` is required for tax clearance, which is per fiscal year. */
export const AddVendorKycDocumentBodySchema = z
  .strictObject({
    docType: VendorKycDocTypeSchema,
    documentId: z.guid(),
    validFrom: isoDate.optional(),
    validUntil: isoDate.optional(),
  })
  .refine((v) => v.docType !== 'tax_clearance' || v.validUntil !== undefined, {
    message: 'tax clearance needs an expiry date',
    path: ['validUntil'],
  });
export type AddVendorKycDocumentBody = z.infer<typeof AddVendorKycDocumentBodySchema>;

// ---------------------------------------------------------------------------------------------
// Bank accounts (maker-checker, AD9)
// ---------------------------------------------------------------------------------------------

/** What the proposer types. The API encrypts the number; it never comes back out of any DTO. */
export const ProposeBankAccountBodySchema = z.strictObject({
  bankName: text(120),
  branch: text(120).optional(),
  accountName: text(160),
  accountNumber: z.string().regex(/^[0-9A-Za-z-]{6,34}$/, 'use 6 to 34 letters, digits or hyphens'),
  swift: z
    .string()
    .regex(/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/, 'a SWIFT code is 8 or 11 characters')
    .optional(),
});
export type ProposeBankAccountBody = z.infer<typeof ProposeBankAccountBodySchema>;

/** The verifier must differ from the proposer (the service checks) and attach the call-back evidence. */
export const VerifyBankAccountBodySchema = z.strictObject({
  callbackEvidenceDocumentId: z.guid(),
});
export type VerifyBankAccountBody = z.infer<typeof VerifyBankAccountBodySchema>;

export const RejectBankAccountBodySchema = z.strictObject({ reason: text(500) });
export type RejectBankAccountBody = z.infer<typeof RejectBankAccountBodySchema>;

/** The internal view of an account: last four digits only, never the number, its ciphertext or its fingerprint. */
export const VendorBankAccountDtoSchema = z.strictObject({
  id: z.guid(),
  vendorPartyId: z.guid(),
  bankName: z.string(),
  branch: z.string().nullable(),
  accountName: z.string(),
  accountLast4: z.string().regex(/^[0-9A-Za-z]{1,4}$/),
  status: BankAccountStatusSchema,
  proposedVia: BankProposedViaSchema,
  verifiedAt: isoDateTime.nullable(),
});
export type VendorBankAccountDto = z.infer<typeof VendorBankAccountDtoSchema>;
