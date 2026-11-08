// Shapes of the quotation reference lists (GET /v1/tax-codes, GET /v1/payment-terms): the pure mapping from a
// database row to the contracts' TaxCodeSchema and PaymentTermSchema, and the Kathmandu day a tax code is
// "in force" on.
import type { PaymentTerm, TaxCode } from '@bos/contracts';
import { kathmanduDate } from '@bos/locale';

import type { TaxCodeRow } from '../pricing/tax-codes.resolver';

/** Basis points as percent text for the label: 1300 is "13", 650 is "6.5", 1 is "0.01". Exact: integers only. */
export function percentText(rateBp: number): string {
  const whole = Math.floor(rateBp / 100);
  const fraction = String(rateBp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${whole}.${fraction}`;
}

/** The calendar day (YYYY-MM-DD) in Asia/Kathmandu at `instant`: the day the tax periods are read for. */
export function kathmanduDay(instant: Date): string {
  const { y, m, d } = kathmanduDate(instant);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function toTaxCodeDto(row: TaxCodeRow): TaxCode {
  return {
    id: row.id,
    label: row.name,
    rate: percentText(row.rateBp),
    code: row.code,
    kind: row.kind,
    rateBp: row.rateBp,
  };
}

export function toPaymentTermDto(row: { id: string; name: string }): PaymentTerm {
  return { id: row.id, label: row.name };
}
