// The settings an admin may change, each with the schema its value must satisfy.
// Serves the NFR "configuration changes are versioned": the API validates against SETTINGS before
// writing a new row, so a bad value can never become the current one.
import { z } from 'zod';

import { SlaSpecSchema } from './approvals.js';
import { PrintAddressSchema } from './addresses.js';
import { NepalPanSchema, PanVatNoSchema } from './crm.js';
import {
  CompanyProfileSchema,
  DEFAULT_DOCUMENT_STYLE,
  DocumentStyleSchema,
  EMPTY_COMPANY_PROFILE,
  DateFormatSchema,
  DEFAULT_DATE_FORMAT,
  DEFAULT_NUMBER_SYSTEMS,
  DEFAULT_TERM_PRESETS,
  NumberSystemsSchema,
  TermPresetListSchema,
} from './document-style.js';
import { CurrencySchema, DecimalString } from './money.js';
import { EVIDENCE_KINDS, NonNegativeDecimalString } from './quotations.js';
import { DEFAULT_SALES_SCHEDULE, ScheduleTemplateSchema } from './sales.js';

/**
 * Evidence an accepted quotation needs before Won: one evidence kind, or `both`, which means a contract AND a
 * purchase order. Built from EVIDENCE_KINDS so a kind cannot be renamed in one place only.
 */
export const EVIDENCE_POLICIES = [...EVIDENCE_KINDS, 'both'] as const;
export const EvidencePolicySchema = z.enum(EVIDENCE_POLICIES);
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;

/**
 * P4 procurement and payables settings (a separate block so it merges cleanly). Percentages and NPR
 * amounts are strings like `tax.vat_rate`, so decimal.js reads them exactly (ADR 0024).
 */
const PercentString = DecimalString.refine(
  (v) => Number(v) >= 0 && Number(v) <= 100,
  'must be 0 to 100',
);
export const P4_SETTINGS = {
  /** Quotes an RFQ needs before a recommendation; fewer needs a written reason (AD13). */
  'procurement.min_quotes': z.number().int().min(1).max(10),
  /** How far above the PO quantity a bill line may go, in percent (AD6). 0 means no tolerance. */
  'procurement.match.qty_pct': PercentString,
  /** Price tolerance per bill line, in percent of the PO price; the lower of this and the NPR figure applies. */
  'procurement.match.price_pct': PercentString,
  /** Price tolerance per bill line in NPR. */
  'procurement.match.price_npr': NonNegativeDecimalString,
  /** A commitment or payment above this NPR total adds a Management step (AD4). */
  'procurement.band.management_npr': NonNegativeDecimalString,
  /** Above this NPR total a Founder step is added too (AD4). */
  'procurement.band.founder_npr': NonNegativeDecimalString,
} as const;

/** Defaults of the P4 keys. The API's SETTING_DEFAULTS spreads these, so the two cannot drift apart. */
export const P4_SETTING_DEFAULTS = {
  'procurement.min_quotes': 3,
  'procurement.match.qty_pct': '0',
  'procurement.match.price_pct': '2',
  'procurement.match.price_npr': '500',
  'procurement.band.management_npr': '100000',
  'procurement.band.founder_npr': '1000000',
} as const satisfies { [K in keyof typeof P4_SETTINGS]: z.infer<(typeof P4_SETTINGS)[K]> };

/**
 * Sales delivery-hold settings (F1-Q32), a block of their own so parallel edits merge cleanly. A hardware delivery
 * on hold is released by Finance; above this NPR amount only Management may release it (see `deliveryHoldReleaser`
 * in @bos/money-rules). The amount is a string like the other NPR settings, so decimal.js reads it exactly.
 */
export const DELIVERY_HOLD_SETTINGS = {
  /** Above this NPR amount a delivery-hold release needs Management instead of Finance. 0 or more, 2 decimals. */
  'sales.delivery_hold.management_npr': NonNegativeDecimalString,
} as const;

/** `entity.pan_vat_no` as a stored row may still look (5 to 20 characters, from before the nine-digit rule). Reads only. */
export const StoredEntityPanVatNoSchema = PanVatNoSchema.nullable();

/** Defaults of the delivery-hold keys (D32: every setting has a default). */
export const DELIVERY_HOLD_SETTING_DEFAULTS = {
  'sales.delivery_hold.management_npr': '100000',
} as const satisfies {
  [K in keyof typeof DELIVERY_HOLD_SETTINGS]: z.infer<(typeof DELIVERY_HOLD_SETTINGS)[K]>;
};

export const SETTINGS = {
  /** Used when a workflow spec leaves its `sla` out. */
  'approvals.sla_defaults': SlaSpecSchema,
  /** Currencies a document may use. NPR is the books' currency, so it can never be switched off. */
  'currency.enabled': z
    .array(CurrencySchema)
    .min(1)
    .refine((list) => list.includes('NPR'), 'NPR must stay enabled')
    .refine((list) => new Set(list).size === list.length, 'currencies must be unique'),
  /** VAT as a percentage (13 means 13%), 0 to 100 with at most 2 decimals. */
  'tax.vat_rate': DecimalString.refine(
    (v) => Number(v) >= 0 && Number(v) <= 100,
    'must be 0 to 100',
  ),
  /** Prefix of memo numbers such as MEMO-2082/83-00001. */
  'numbering.memo_prefix': z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'use 2 to 10 capitals or digits'),
  /** Oldest FX rate a document may use, in days. Past it the API answers 409 `fx_rate_stale`. */
  'fx.max_rate_age_days': z.number().int().min(1).max(365),
  /** Days a sent quotation stays valid when the author gives no expiry. */
  'quotation.validity_days': z.number().int().min(1).max(365),
  /** What a quotation needs on file before the opportunity may become Won. */
  'sales.evidence_policy': EvidencePolicySchema,
  /** The selling entity's PAN or VAT number as quotations print it. Per entity; null until an admin sets it. */
  'entity.pan_vat_no': NepalPanSchema.nullable(),
  /** The selling entity's address as quotations print it. Per entity; null until set, and no PDF renders without it. */
  'entity.address': PrintAddressSchema.nullable(),
  // P3 sales and invoicing.
  /** Billing split used when the accepted quotation has no payment schedule: slices that add up to 100%. */
  'sales.default_schedule': ScheduleTemplateSchema,
  /** Company details the document footer and signature print. Per entity. The logo is a document id, never bytes. */
  'entity.profile': CompanyProfileSchema,
  /** Layout and brand colour of customer documents. Per entity; only the Founder changes it. */
  'document.style': DocumentStyleSchema,
  /** Per currency, South Asian (lakh, crore) or International (million, billion): drives amount grouping and amount in words (D30). */
  'format.number_systems': NumberSystemsSchema,
  /** How customer-facing documents print calendar dates (D27 default `19 Nov 2026`). */
  'format.date': DateFormatSchema,
  /** Saved wording the quotation form offers for payment terms, scope and the like. */
  'quotation.term_presets': TermPresetListSchema,
  /**
   * F1-Q21: who owns a new lead when its creator may not own it and names no owner (Finance, Accountant and PMO
   * starting leads for Sales; the intended home of website leads). Per entity. A user id; null (the default) keeps
   * today's choice, the Sales head. A user who could not be handed the lead then is skipped the same way.
   */
  'crm.default_lead_owner': z.guid().nullable(),
  ...P4_SETTINGS,
  ...DELIVERY_HOLD_SETTINGS,
} as const;

/** Defaults of the document and format keys. The API's SETTING_DEFAULTS spreads these in. */
export const DOCUMENT_SETTING_DEFAULTS = {
  'entity.profile': EMPTY_COMPANY_PROFILE,
  'document.style': DEFAULT_DOCUMENT_STYLE,
  'format.number_systems': DEFAULT_NUMBER_SYSTEMS,
  'format.date': DEFAULT_DATE_FORMAT,
  'quotation.term_presets': DEFAULT_TERM_PRESETS,
} as const satisfies {
  [
    K in
      | 'entity.profile'
      | 'document.style'
      | 'format.number_systems'
      | 'format.date'
      | 'quotation.term_presets'
  ]: z.infer<(typeof SETTINGS)[K]>;
};

/** Defaults of the P2 keys. The API's SETTING_DEFAULTS reuses these, so the two cannot drift apart. */
export const P2_SETTING_DEFAULTS = {
  'fx.max_rate_age_days': 7,
  'quotation.validity_days': 15,
  'sales.evidence_policy': 'signed_quote',
  'entity.pan_vat_no': null,
  'entity.address': null,
} as const satisfies {
  [
    K in
      | 'fx.max_rate_age_days'
      | 'quotation.validity_days'
      | 'sales.evidence_policy'
      | 'entity.pan_vat_no'
      | 'entity.address'
  ]: z.infer<(typeof SETTINGS)[K]>;
};

/** Defaults of the CRM keys (F1-Q21). Null keeps today's behaviour: the Sales head owns a lead nobody would. */
export const CRM_SETTING_DEFAULTS = {
  'crm.default_lead_owner': null,
} as const satisfies { [K in 'crm.default_lead_owner']: z.infer<(typeof SETTINGS)[K]> };

/** Defaults of the P3 keys. The API's SETTING_DEFAULTS spreads these in beside the P2 ones. */
export const P3_SETTING_DEFAULTS = {
  'sales.default_schedule': DEFAULT_SALES_SCHEDULE,
} as const satisfies { [K in 'sales.default_schedule']: z.infer<(typeof SETTINGS)[K]> };

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

/**
 * What every key reads as before anyone writes it: today's behaviour (D32). The API reads it for an unset key and the
 * workspace compares a saved value with it to show the undo icon, so there is one source. Each entry is checked
 * against SETTINGS in a test.
 */
export const SETTING_DEFAULTS: { readonly [K in SettingKey]: SettingValue<K> } = {
  'currency.enabled': ['NPR', 'INR', 'USD'],
  'tax.vat_rate': '13',
  'numbering.memo_prefix': 'MEMO',
  // The schema fills in its own defaults (24 h, 72 h, founder), so the two never drift apart.
  'approvals.sla_defaults': SlaSpecSchema.parse({}),
  ...P2_SETTING_DEFAULTS,
  ...P3_SETTING_DEFAULTS,
  ...CRM_SETTING_DEFAULTS,
  ...P4_SETTING_DEFAULTS,
  ...DELIVERY_HOLD_SETTING_DEFAULTS,
  ...DOCUMENT_SETTING_DEFAULTS,
};
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const SettingKeySchema = z.enum(Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]]);
