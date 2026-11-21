import type { CreditHoldDto } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';

import { money } from '@/lib/kernel-format';

/** What the Override credit hold dialog shows of the customer's position: display text, built on the server. */
export interface CreditPositionView {
  /** The pending order's value the position was read with; the override is given for exactly this (R5 FU4). */
  orderValue: string;
  rows: { label: string; value: string }[];
  /** Why an override is needed again, when an earlier one no longer covers the order. */
  note?: string;
}

/**
 * The amounts a credit hold is made of (F1-Q20/F1-Q26, R5 FU4), one rule for the deal's banner and the Override
 * dialog: the limit, what the customer owes, what its confirmed orders have not invoiced yet, this deal's order and
 * their total. The uninvoiced and order lines are left out when they are zero, as the position reads without them.
 */
export function creditPositionView(
  hold: CreditHoldDto,
  numberSystems: NumberSystems,
): CreditPositionView {
  const amount = (value: string) => money(value, hold.currency, numberSystems);
  const rows = [
    {
      label: 'Credit limit',
      value: hold.creditLimit === null ? 'No limit' : amount(hold.creditLimit),
    },
    { label: 'Open receivables', value: amount(hold.exposure) },
  ];
  if (Number(hold.uninvoiced) > 0) {
    rows.push({ label: 'Confirmed orders not yet invoiced', value: amount(hold.uninvoiced) });
  }
  if (Number(hold.orderValue) > 0)
    rows.push({ label: 'This order', value: amount(hold.orderValue) });
  rows.push({ label: 'Total against the limit', value: amount(hold.exposureWithOrder) });
  const earlier = hold.override;
  return {
    orderValue: hold.orderValue,
    rows,
    ...(earlier !== null && !hold.overrideCovers
      ? {
          note:
            earlier.orderValue === null
              ? 'An earlier override on this deal did not record the order it was for, so it no longer applies.'
              : `An earlier override on this deal was for an order of ${amount(earlier.orderValue)}; this order is worth more.`,
        }
      : {}),
  };
}
