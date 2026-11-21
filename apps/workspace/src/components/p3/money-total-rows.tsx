import type { Currency, MoneyTotals } from '@bos/contracts';

import { Td, Th } from '@/components/ui/table';

/**
 * A list table's footer (D56 U15b-Q4): the money column summed over every match, one row per currency because
 * amounts in different currencies are never added together. The sums are the server's (X-Money-Totals); this
 * only lays them out under the money column. Renders nothing when the server sent none.
 */
export function MoneyTotalRows({
  totals,
  column,
  columns,
  allPages,
  pinned = false,
  format,
}: {
  totals: MoneyTotals | null;
  /** The money column's index (0-based) in the table. */
  column: number;
  /** How many columns the table has. */
  columns: number;
  /** True when the matches run past this page, so the label says the total is not this page's. */
  allPages: boolean;
  /**
   * True when the table pins the money column and every column after it (Table's `pinned` cells): the sum then stays
   * under its header while the rest scrolls, and the columns after it are drawn as separate empty pinned cells.
   */
  pinned?: boolean;
  format: (amount: string, currency: Currency) => string;
}) {
  if (totals === null || totals.length === 0) return null;
  const label = allPages ? 'Total, all pages' : 'Total';
  return (
    <tfoot>
      {totals.map((t) => (
        <tr key={t.currency}>
          <Th scope="row" colSpan={column}>
            {totals.length > 1 ? `${label} · ${t.currency}` : label}
          </Th>
          <Td align="end" nowrap pinned={pinned}>
            {format(t.amount, t.currency)}
          </Td>
          {pinned ? (
            Array.from({ length: columns - column - 1 }, (_, i) => <Td key={i} pinned />)
          ) : columns - column - 1 > 0 ? (
            <Td colSpan={columns - column - 1} />
          ) : null}
        </tr>
      ))}
    </tfoot>
  );
}
