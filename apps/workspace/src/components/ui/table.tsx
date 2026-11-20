import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import styles from './table.module.css';
import { PinnedColumnOffsets } from './table-pinned';

type Align = 'start' | 'end';

/**
 * Data table (Figma table pattern 418:12229): a white card with a header row, hairline rows and a
 * hover highlight. It keeps native table elements, so screen readers get rows, columns and
 * headers for free.
 *
 * - `caption` names the table (it is the table's accessible name, drawn off screen). The visible
 *   page heading usually says the same thing; use a more specific name when it does not.
 * - The wrapper scrolls sideways on narrow screens. It is a focusable region so a keyboard user
 *   can scroll it.
 * - `stickyFirstColumn` pins the first column while scrolling (the roles matrix needs it).
 * - Mark the trailing Status and Action cells `pinned` on `Th` and `Td` (Figma's pinned columns): they sit on a
 *   shaded band behind a divider and stay in view while the rest scrolls sideways (on a phone only the last one does),
 *   so the Action column is always reachable. Pinned columns must be the last ones of the row; up to four are supported.
 * - Write the rows as `<thead><tr><Th>..</Th></tr></thead><tbody><tr><Td>..</Td></tr></tbody>`.
 */
export function Table({
  caption,
  stickyFirstColumn = false,
  minWidth = 560,
  className,
  children,
}: {
  caption: string;
  stickyFirstColumn?: boolean;
  /** Width in px under which the table scrolls instead of squeezing its columns. */
  minWidth?: number;
  className?: string;
  children: ReactNode;
}) {
  const wrap = [styles.wrap, className].filter(Boolean).join(' ');
  const table = [styles.table, stickyFirstColumn ? styles.sticky : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={wrap}
      role="region"
      aria-label={`${caption} (scrolls sideways on narrow screens)`}
      tabIndex={0}
    >
      <table className={table} style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
      <PinnedColumnOffsets />
    </div>
  );
}

/**
 * A column header. `align="end"` right-aligns a numeric column (and its cells). `pinned` makes it one of the
 * trailing pinned columns (see Table); mark the column's cells `pinned` too.
 */
export function Th({
  align = 'start',
  scope = 'col',
  pinned = false,
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<'th'>, 'align'> & { align?: Align; pinned?: boolean }) {
  const cls = [align === 'end' ? styles.end : undefined, className].filter(Boolean).join(' ');
  return (
    <th
      scope={scope}
      className={cls || undefined}
      data-pinned={pinned ? '' : undefined}
      {...rest}
    />
  );
}

/** A cell. Numbers use tabular figures so digits line up. `pinned` puts it in a trailing pinned column (see Table). */
export function Td({
  align = 'start',
  nowrap = false,
  pinned = false,
  className,
  ...rest
}: Omit<ComponentPropsWithoutRef<'td'>, 'align'> & {
  align?: Align;
  nowrap?: boolean;
  pinned?: boolean;
}) {
  const cls = [
    align === 'end' ? styles.end : undefined,
    nowrap ? styles.nowrap : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <td className={cls || undefined} data-pinned={pinned ? '' : undefined} {...rest} />;
}

/**
 * The main content of a cell: a title (often a link) with a small caption beside it (an id or
 * number), and an optional note line under both (a reason, a summary).
 */
export function CellTitle({
  title,
  meta,
  note,
}: {
  title: ReactNode;
  meta?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className={styles.cellTitle}>
      <span className={styles.cellHead}>
        <span className={styles.cellMain}>{title}</span>
        {meta ? <span className={styles.cellMeta}>{meta}</span> : null}
      </span>
      {note ? <span className={styles.cellNote}>{note}</span> : null}
    </div>
  );
}
