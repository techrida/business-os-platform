// The settings each card section may write: the Server Action refuses any other key, so a form
// cannot be pointed at a setting that belongs to another section. Plain module (no 'use server').
import type { SettingKey } from '@bos/contracts';

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
