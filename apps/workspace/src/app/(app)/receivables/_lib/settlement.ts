// How an invoice's settlement status reads in the workspace. Pure data with no React import, so the
// statement and the tests share it. Serves plan A8: the status is derived on the server from
// allocations, credit notes and the due date; this file only gives each value its words and tone.
// Nothing here works a status out.
import { SETTLEMENT_STATUSES, type SettlementStatus } from '@bos/contracts';

export type SettlementTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface SettlementMeta {
  label: string;
  tone: SettlementTone;
}

/** A full record, so a status added to the contract is a compile error here until it is worded. */
const META: Record<SettlementStatus, SettlementMeta> = {
  unpaid: { label: 'Unpaid', tone: 'neutral' },
  partly_paid: { label: 'Partly paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'error' },
  credited: { label: 'Credited', tone: 'info' },
};

export function settlementMeta(status: SettlementStatus): SettlementMeta {
  return META[status];
}

export const SETTLEMENT_OPTIONS: readonly { value: SettlementStatus; label: string }[] =
  SETTLEMENT_STATUSES.map((value) => ({ value, label: META[value].label }));
