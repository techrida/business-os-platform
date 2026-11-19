// The settings each card section may write: the Server Action refuses any other key, so a form
// cannot be pointed at a setting that belongs to another section. Plain module (no 'use server').
import type { SettingKey } from '@bos/contracts';

import type { SettingsSectionId } from '@/lib/settings-nav';

export const CARD_KEYS = {
  currencies: ['currency.enabled', 'fx.max_rate_age_days'],
  tax: ['tax.vat_rate'],
  numbering: ['numbering.memo_prefix'],
  sales: ['quotation.validity_days', 'sales.evidence_policy', 'sales.default_schedule'],
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
 * The settings each section's "reset to default" may write (D32): its card keys, plus the keys of
 * the sections that have their own editors. A separate list, so widening what a reset may touch
 * never widens what `saveCardAction` accepts.
 */
export const RESET_KEYS = {
  ...CARD_KEYS,
  company: ['entity.profile', 'entity.pan_vat_no', 'entity.address'],
  documents: ['document.style'],
  formats: ['format.number_systems', 'format.date'],
  terms: ['quotation.term_presets'],
} as const satisfies Partial<Record<SettingsSectionId, readonly SettingKey[]>>;
