// The amounts of a quotation's payment schedule (D36). Serves the NFR "amounts are exact": the API is the only
// place that splits a version total over its milestones, so the workspace, the PDF and the portal show identical
// figures and never recompute them. D22: two decimals, each share half up, the remainder on the last row.
// The stored jsonb (and the draft input contract) carries only label, percent and due text, never an amount.
import type { PaymentMilestone, PaymentMilestoneDto } from '@bos/contracts';
import { Dec, allocatePaymentSchedule } from '@bos/locale';

/**
 * `milestones` with their `amount`, in document-currency terms: `total` split by each percent. Every row but the
 * last is `total * percent / 100` rounded half up to two decimals (never more than what is left); the last row
 * takes the rest, so the amounts add up to `total` exactly. An empty schedule gives an empty list. `total` is the
 * version's stored total (two decimals).
 */
export function paymentScheduleAmounts(
  total: string,
  milestones: readonly PaymentMilestone[],
): PaymentMilestoneDto[] {
  const amounts = allocatePaymentSchedule(
    new Dec(total),
    milestones.map((m) => m.percent),
  );
  return milestones.map((m, i) => ({ ...m, amount: amounts[i]!.toFixed(2) }));
}
