// The settings each card section may write: the Server Action refuses any other key, so a form
// cannot be pointed at a setting that belongs to another section. Plain module (no 'use server').
import type { SettingKey } from '@bos/contracts';

import type { SettingsSectionId } from '@/lib/settings-nav';

export const CARD_KEYS = {
  currencies: ['currency.enabled', 'fx.max_rate_age_days'],
  tax: ['tax.vat_rate'],
  numbering: ['numbering.memo_prefix'],
  sales: [
    'quotation.validity_days',
    'sales.evidence_policy',
    'sales.default_schedule',
    'sales.delivery_hold.management_npr',
    'crm.default_lead_owner',
  ],
  purchasing: [
    'procurement.min_quotes',
    'procurement.match.qty_pct',
    'procurement.match.price_pct',
    'procurement.match.price_npr',
    'procurement.band.management_npr',
    'procurement.band.founder_npr',
  ],
  workflows: ['approvals.sla_defaults'],
} as const satisfies Record<string, readonly SettingKey[]>;

/**
 * The settings the generic "reset to default" (`resetSettingAction`) may write (D32): its card keys,
 * plus the document style and the saved term sets. A separate list, so widening what a reset may
 * touch never widens what `saveCardAction` accepts. Sections with their own versioned reset actions
 * (company profile cards, number and date formats) are deliberately absent: the generic reset would
 * write a whole setting (the company profile includes the logo and every card) or skip their checks.
 */
export const RESET_KEYS = {
  ...CARD_KEYS,
  documents: ['document.style'],
  terms: ['quotation.term_presets'],
} as const satisfies Partial<Record<SettingsSectionId, readonly SettingKey[]>>;
