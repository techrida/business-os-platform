// Contracts for the vendor portal (P4). Serves the NFR "a vendor sees only what we meant to show": every
// view is a strict allow-list, so an object with an extra key (a score, a cost centre, a match variance)
// fails to parse instead of leaking. A mapper builds each view field by field; nothing is spread into it.
// Writes are inbox only: a submission creates a row staff convert, never a ledger document.
import { z } from 'zod';

import { CurrencySchema, DecimalString } from './money.js';
import { type PoStatus } from './procurement.js';
import { NonNegativeDecimalString } from './quotations.js';
import {
  AddVendorKycDocumentBodySchema,
  BankAccountStatusSchema,
  ProposeBankAccountBodySchema,
  VendorKycDocTypeSchema,
  VendorKycReviewStatusSchema,
  VendorStatusSchema,
  type VendorStatus,
} from './vendors.js';

const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------------------------
// What a vendor may see
// ---------------------------------------------------------------------------------------------

/**
 * Purchase order states a vendor may see: issued versions only. A draft and an order whose amendment is
 * pending are invisible (the vendor keeps seeing the last issued version); the portal answers 404.
 */
export const VENDOR_VISIBLE_PO_STATUSES = [
  'issued',
  'partially_received',
  'fully_received',
  'closed',
  'short_closed',
  'cancelled',
] as const satisfies readonly PoStatus[];
export const VendorVisiblePoStatusSchema = z.enum(VENDOR_VISIBLE_PO_STATUSES);
export type VendorVisiblePoStatus = z.infer<typeof VendorVisiblePoStatusSchema>;

export const isVendorVisiblePoStatus = (s: PoStatus): s is VendorVisiblePoStatus =>
  (VENDOR_VISIBLE_PO_STATUSES as readonly string[]).includes(s);

/** A bill's status as a vendor sees it: coarse on purpose, so matching and approval steps stay private. */
export const VENDOR_PORTAL_BILL_STATUSES = [
  'received',
  'under_review',
  'approved_for_payment',
  'rejected',
] as const;
export const VendorPortalBillStatusSchema = z.enum(VENDOR_PORTAL_BILL_STATUSES);
export type VendorPortalBillStatus = z.infer<typeof VendorPortalBillStatusSchema>;

/** What a vendor may do, by vendor status (A4 section 5, rule 2). */
export const VENDOR_PORTAL_CAPABILITIES = ['onboarding_only', 'full', 'read_only', 'none'] as const;
export const VendorPortalCapabilitySchema = z.enum(VENDOR_PORTAL_CAPABILITIES);
export type VendorPortalCapability = z.infer<typeof VendorPortalCapabilitySchema>;

export function vendorPortalCapability(status: VendorStatus): VendorPortalCapability {
  switch (status) {
    case 'draft':
    case 'pending_kyc':
    case 'under_review':
      return 'onboarding_only';
    case 'approved':
      return 'full';
    case 'suspended':
      return 'read_only';
    case 'blocked':
    case 'archived':
      return 'none';
  }
}

// ---------------------------------------------------------------------------------------------
// Allow-list views
// ---------------------------------------------------------------------------------------------

const FileBlock = z.strictObject({ documentId: z.guid(), filename: z.string(), sha256: sha256Hex });

export const VendorPortalPurchaseOrderViewSchema = z.strictObject({
  /** The PO id; the portal checks it against the vendor's own party before answering. */
  id: z.guid(),
  number: z.string().min(1).max(32),
  /** The issued version the vendor is looking at. */
  version: z.number().int().min(1),
  status: VendorVisiblePoStatusSchema,
  issueDate: isoDate,
  currency: CurrencySchema,
  total: DecimalString,
  paymentTermsDays: z.number().int().min(0),
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: z.string(),
      unitPrice: DecimalString,
      /** Confirmed receipt quantity against this line. */
      receivedQuantity: z.string(),
    }),
  ),
  /** The frozen PDF. Null until it is rendered and scanned clean. */
  file: FileBlock.nullable(),
});
export type VendorPortalPurchaseOrderView = z.infer<typeof VendorPortalPurchaseOrderViewSchema>;

export const VendorPortalPurchaseOrderListItemSchema = z.strictObject({
  id: z.guid(),
  number: z.string().min(1).max(32),
  version: z.number().int().min(1),
  status: VendorVisiblePoStatusSchema,
  issueDate: isoDate,
  currency: CurrencySchema,
  total: DecimalString,
});
export type VendorPortalPurchaseOrderListItem = z.infer<
  typeof VendorPortalPurchaseOrderListItemSchema
>;

/** A vendor's bill. The TDS amount on their own bill is shown; the TDS account mapping never is. */
export const VendorPortalBillViewSchema = z.strictObject({
  id: z.guid(),
  number: z.string().min(1).max(32),
  vendorInvoiceNo: z.string(),
  invoiceDate: isoDate,
  currency: CurrencySchema,
  payableTotal: DecimalString,
  tdsAmount: DecimalString,
  status: VendorPortalBillStatusSchema,
  /** Payments executed against this bill: date, amount and bank reference. */
  payments: z.array(
    z.strictObject({ paidOn: isoDate, amount: DecimalString, reference: z.string() }),
  ),
});
export type VendorPortalBillView = z.infer<typeof VendorPortalBillViewSchema>;

/**
 * An RFQ a vendor is invited to, to quote on. Only what is needed to price it: the number, the deadline and the
 * lines (description, quantity, unit). No estimate, budget, other invited vendor, score or internal note.
 * Only an open RFQ is shown; a closed, recommended or cancelled one is a 404.
 */
export const VendorPortalRfqListItemSchema = z.strictObject({
  id: z.guid(),
  number: z.string().min(1).max(32),
  /** The instant quotations close, as an ISO datetime (UTC). */
  deadline: z.iso.datetime(),
});
export type VendorPortalRfqListItem = z.infer<typeof VendorPortalRfqListItemSchema>;

export const VendorPortalRfqViewSchema = z.strictObject({
  ...VendorPortalRfqListItemSchema.shape,
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: z.string(),
    }),
  ),
});
export type VendorPortalRfqView = z.infer<typeof VendorPortalRfqViewSchema>;

/** A bank account as the vendor sees it: bank, last four digits and status. Never the number. */
export const VendorPortalBankViewSchema = z.strictObject({
  bankName: z.string(),
  accountLast4: z.string().regex(/^[0-9A-Za-z]{1,4}$/),
  status: BankAccountStatusSchema,
});
export type VendorPortalBankView = z.infer<typeof VendorPortalBankViewSchema>;

/** Onboarding progress. It carries no review note: a reviewer's comment is internal. */
export const VendorPortalOnboardingViewSchema = z.strictObject({
  status: VendorStatusSchema,
  capability: VendorPortalCapabilitySchema,
  /**
   * Set when a change of the company's details (legal name, PAN, kind or country) reset the checklist: when, and the
   * name of the staff member who made it. The documents have to be uploaded again; a file sent before cannot be reused.
   */
  detailsChanged: z
    .strictObject({ at: z.iso.datetime({ offset: true }), by: z.string().nullable() })
    .nullable(),
  documents: z.array(
    z.strictObject({
      docType: VendorKycDocTypeSchema,
      state: z.union([z.literal('missing'), VendorKycReviewStatusSchema]),
      validUntil: isoDate.nullable(),
    }),
  ),
});
export type VendorPortalOnboardingView = z.infer<typeof VendorPortalOnboardingViewSchema>;

// ---------------------------------------------------------------------------------------------
// Internal-field guard
// ---------------------------------------------------------------------------------------------

/**
 * Words that mark a field as internal. A test splits every key of a view into words (camelCase and
 * snake_case) and fails if any is listed here. Comparison scores, other vendors' quotes, approval data,
 * cost centres, budget codes, review notes, match variances and the TDS account mapping stay inside.
 */
export const VENDOR_PORTAL_FORBIDDEN_WORDS: readonly string[] = [
  'score',
  'comparison',
  'note',
  'review',
  'approval',
  'approver',
  'cost',
  'budget',
  'variance',
  'internal',
  'ledger',
  'mapping',
];

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Every key at any depth of `value` that has a forbidden word in it, in traversal order. */
export function forbiddenPortalKeys(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === 'object') {
      for (const [key, child] of Object.entries(v)) {
        if (keyWords(key).some((w) => VENDOR_PORTAL_FORBIDDEN_WORDS.includes(w))) found.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Inbox writes. Each creates a row staff review; none creates a ledger document.
// ---------------------------------------------------------------------------------------------

/** The vendor's bill, as they claim it. Staff key the real bill and run the match. */
export const VendorBillSubmissionBodySchema = z.strictObject({
  purchaseOrderId: z.guid().optional(),
  vendorInvoiceNo: text(64),
  invoiceDate: isoDate,
  currency: CurrencySchema,
  claimedTotal: NonNegativeDecimalString,
  documentId: z.guid(),
});
export type VendorBillSubmissionBody = z.infer<typeof VendorBillSubmissionBodySchema>;

export const VendorQuotationSubmissionBodySchema = z.strictObject({
  rfqId: z.guid(),
  vendorRef: text(64).optional(),
  validUntil: isoDate.optional(),
  currency: CurrencySchema,
  total: NonNegativeDecimalString,
  deliveryDays: z.number().int().min(0).max(1000).optional(),
  documentId: z.guid(),
});
export type VendorQuotationSubmissionBody = z.infer<typeof VendorQuotationSubmissionBodySchema>;

/** A KYC upload from the portal: the same shape as the staff body, including the tax-clearance expiry. */
export const VendorKycDocumentSubmissionBodySchema = AddVendorKycDocumentBodySchema;
export type VendorKycDocumentSubmissionBody = z.infer<typeof VendorKycDocumentSubmissionBodySchema>;

/** The portal can only propose an account; staff verify it with call-back evidence (AD9). */
export const VendorBankChangeRequestBodySchema = ProposeBankAccountBodySchema.extend({
  supportingDocumentId: z.guid().optional(),
});
export type VendorBankChangeRequestBody = z.infer<typeof VendorBankChangeRequestBodySchema>;
