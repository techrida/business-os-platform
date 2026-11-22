// Contracts for the customer portal. Serves the NFR "a customer sees only what we meant to show":
// `CustomerQuotationView` is a whitelist, and it is the only thing the PDF renderer and the portal
// API are given. It has no unit cost, margin, FX rate, NPR equivalent, approval or editor data.
import { z } from 'zod';

import { AddressLinesSchema } from './addresses.js';
import { CountryCodeSchema } from './countries.js';
import { PanVatNoSchema } from './crm.js';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  DateFormatSchema,
  NumberSystemsSchema,
} from './document-style.js';
import { CurrencySchema, DecimalString, type Currency } from './money.js';
import {
  EvidenceKindSchema,
  PaymentMilestoneDtoSchema,
  PercentFourDecimals,
  QuantityString,
  type QuotationStatus,
} from './quotations.js';
import { SETTINGS, SETTING_DEFAULTS } from './settings.js';

const isoDate = z.iso.date();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The only states a customer may see. A draft, a version in approval, and an approved version that
 * was never sent are invisible: the portal answers 404, not 403. A `rejected` version is visible
 * only when the customer rejected it; the mapper must not expose an internal rejection.
 */
export const CUSTOMER_VISIBLE_STATUSES = [
  'sent',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const;
export const CustomerVisibleStatusSchema = z.enum(CUSTOMER_VISIBLE_STATUSES);
export type CustomerVisibleStatus = z.infer<typeof CustomerVisibleStatusSchema>;

export const isCustomerVisibleStatus = (s: QuotationStatus): s is CustomerVisibleStatus =>
  (CUSTOMER_VISIBLE_STATUSES as readonly string[]).includes(s);

/**
 * Words that mark a field as internal. A test splits every key of the view into words (camelCase
 * and snake_case) and fails if any is listed here; the PDF text check can reuse the list.
 * The VAT percentage the customer must see is named `percent`, not `rate`, so this list stays strict.
 */
export const CUSTOMER_VIEW_FORBIDDEN_WORDS: readonly string[] = [
  'cost',
  'margin',
  'rate',
  'npr',
  'markup',
];

const PartyBlock = z.strictObject({
  legalName: z.string(),
  panVatNo: PanVatNoSchema.nullable(),
  /** The party's country (FX9); the address carries only the street lines and city. */
  country: CountryCodeSchema,
  address: AddressLinesSchema,
});

/** How the selling company writes numbers and dates; the portal draws every amount and date with it (D30, D27). */
export const PortalDisplaySchema = z.strictObject({
  numberSystems: NumberSystemsSchema,
  dateFormat: DateFormatSchema,
  /**
   * The currencies the company has switched on (D44), NPR always among them: a portal form offers only these, and the
   * API refuses any other with 422 CURRENCY_NOT_ENABLED. `GET /v1/portal/display` always fills it; a quotation's
   * frozen display leaves it out. Read it through `portalEnabledCurrencies`, which applies the default when absent.
   */
  enabledCurrencies: SETTINGS['currency.enabled'].optional(),
});
export type PortalDisplay = z.infer<typeof PortalDisplaySchema>;

/** The currencies a portal form may offer: the display's list, or the settings default when it carries none. */
export function portalEnabledCurrencies(
  display: Pick<PortalDisplay, 'enabledCurrencies'>,
): Currency[] {
  return [...(display.enabledCurrencies ?? SETTING_DEFAULTS['currency.enabled'])];
}

/** The display a company that never changed its settings gets. A fresh object each call, so no caller can edit it. */
export function defaultPortalDisplay(): PortalDisplay {
  return { numberSystems: { ...DEFAULT_NUMBER_SYSTEMS }, dateFormat: DEFAULT_DATE_FORMAT };
}

/**
 * What the customer sees of one quotation version. Strict on purpose: an object with an extra key,
 * such as a whole internal version, fails to parse instead of leaking. A mapper builds this field by
 * field from the internal version; nothing is spread into it.
 */
export const CustomerQuotationViewSchema = z.strictObject({
  /** The version id; the portal checks it against the customer's own party before answering. */
  id: z.guid(),
  /** The parent number; a version shows as "<number> Rev <revisionNo>". */
  number: z.string().min(1).max(32),
  revisionNo: z.number().int().min(1),
  status: CustomerVisibleStatusSchema,
  issueDate: isoDate,
  validUntil: isoDate,
  currency: CurrencySchema,
  /** The selling legal entity. */
  issuer: PartyBlock,
  customer: PartyBlock,
  contact: z.strictObject({ fullName: z.string(), email: z.string().nullable() }).nullable(),
  scope: z.string().nullable(),
  assumptions: z.string().nullable(),
  exclusions: z.string().nullable(),
  termsAndConditions: z.string().nullable(),
  deliveryTimeline: z.string().nullable(),
  paymentTermName: z.string().nullable(),
  paymentSchedule: z.array(PaymentMilestoneDtoSchema),
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: QuantityString,
      unitPrice: DecimalString,
      /** Quantity times unit price, before the quotation discount. */
      amount: DecimalString,
    }),
  ),
  totals: z.strictObject({
    subtotal: DecimalString,
    discountAmount: DecimalString,
    taxableAmount: DecimalString,
    taxAmount: DecimalString,
    total: DecimalString,
  }),
  /** `percent` is the VAT or tax percentage, for example "13". */
  taxSummary: z.array(
    z.strictObject({
      label: z.string(),
      percent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
      base: DecimalString,
      tax: DecimalString,
    }),
  ),
  /**
   * Number grouping and date pattern: the ones frozen with this version when it was first rendered, else the
   * selling company's current settings. The portal draws this version's amounts and dates with it.
   */
  display: PortalDisplaySchema,
  /** The frozen PDF. Null until it is rendered and scanned clean. The hash lets the customer check a download. */
  file: z
    .strictObject({ documentId: z.guid(), filename: z.string(), sha256: sha256Hex })
    .nullable(),
  /**
   * On a portal read only (never in the PDF): true when the PDF will not come without the team (its render was given
   * up, or the virus scan refused the file). With `file` null and this false, the PDF is still being prepared.
   */
  renderFailed: z.boolean().optional(),
  /**
   * What happens after the customer accepted (F1-Q28), on a portal read of an accepted version only (never in the
   * PDF): `pending` until staff confirm the acceptance, and the documents they still need from the customer.
   */
  afterAcceptance: z
    .strictObject({
      status: z.enum(['pending', 'confirmed']),
      needs: z.array(EvidenceKindSchema),
    })
    .optional(),
});
export type CustomerQuotationView = z.infer<typeof CustomerQuotationViewSchema>;

/** One row of the customer's quotation list. */
export const PortalQuotationListItemSchema = z.strictObject({
  id: z.guid(),
  number: z.string().min(1).max(32),
  revisionNo: z.number().int().min(1),
  status: CustomerVisibleStatusSchema,
  issueDate: isoDate,
  validUntil: isoDate,
  currency: CurrencySchema,
  total: DecimalString,
});
export type PortalQuotationListItem = z.infer<typeof PortalQuotationListItemSchema>;

/**
 * `POST /v1/portal/quotations/:id/accept`. The typed name and the ticked box are the customer's
 * signature; the API records them as evidence of kind `signed_quote`. Strict, so nothing else can
 * ride along.
 */
export const AcceptQuotationBodySchema = z.strictObject({
  acceptedByName: z.string().trim().min(1).max(200),
  confirm: z.literal(true),
});
export type AcceptQuotationBody = z.infer<typeof AcceptQuotationBodySchema>;

/** `POST /v1/portal/quotations/:id/reject`. The customer's reason is required. */
export const RejectQuotationBodySchema = z.strictObject({
  comment: z.string().trim().min(1).max(2000),
});
export type RejectQuotationBody = z.infer<typeof RejectQuotationBodySchema>;

// ---------------------------------------------------------------------------------------------
// Milestones: the billing schedule of the customer's sales orders (F1-Q34, D15)
// ---------------------------------------------------------------------------------------------

/**
 * What a customer sees of a schedule line's status. `upcoming` (planned), `reached` (the milestone is done and the
 * line waits for its invoice, which covers a drafted invoice: an unissued invoice is never shown), `invoiced` (the
 * line's invoice was issued). A cancelled line is not shown at all.
 */
export const PORTAL_MILESTONE_STATUSES = ['upcoming', 'reached', 'invoiced'] as const;
export const PortalMilestoneStatusSchema = z.enum(PORTAL_MILESTONE_STATUSES);
export type PortalMilestoneStatus = z.infer<typeof PortalMilestoneStatusSchema>;

/** One instalment of the order's billing schedule, field by field (no NPR value, evidence, marker or version). */
export const PortalMilestoneSchema = z.strictObject({
  seq: z.number().int().min(1),
  label: z.string().min(1),
  /** The line's share of the order in percent; null for a line added by amount. */
  percent: PercentFourDecimals.nullable(),
  /** VAT-inclusive, in the order's currency. */
  amount: DecimalString,
  /** When the milestone is planned, when staff set a date; the schedule has no other due date. */
  plannedDate: isoDate.nullable(),
  status: PortalMilestoneStatusSchema,
  /** The issued invoice that billed this line, as the portal's invoice list shows it; null until then. */
  invoice: z
    .strictObject({ id: z.guid(), number: z.string().min(1), dueDate: isoDate.nullable() })
    .nullable(),
});
export type PortalMilestone = z.infer<typeof PortalMilestoneSchema>;

/** A confirmed or completed sales order of the customer with its milestones (`GET /v1/portal/sales-orders`). */
export const PortalSalesOrderSchema = z.strictObject({
  id: z.guid(),
  number: z.string().min(1),
  status: z.enum(['confirmed', 'completed']),
  /** When the order was confirmed (ISO date-time). */
  confirmedAt: z.iso.datetime({ offset: true }).nullable(),
  currency: CurrencySchema,
  total: DecimalString,
  milestones: z.array(PortalMilestoneSchema),
});
export type PortalSalesOrder = z.infer<typeof PortalSalesOrderSchema>;
