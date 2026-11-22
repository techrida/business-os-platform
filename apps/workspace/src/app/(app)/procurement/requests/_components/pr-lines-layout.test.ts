import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

/** The floor of each `minmax(<floor>, …)` column in a template, in rem (a `minmax(0, …)` column counts as 0). */
function columnMinimums(block: string): number[] {
  return [...block.matchAll(/minmax\((\d+(?:\.\d+)?)(rem)?,/g)].map((m) => Number(m[1]));
}

// jsdom has no layout. FQA2 found the purchase request's Quantity box 41px wide at 1440, 23px at 1280
// and 0px at 1100: a number box keeps its unit, steppers and padding at a fixed size, so a column that
// may shrink to 0 leaves the real input nothing. These tests pin the rule that fixed it (every table
// column has a floor, and the table layout only starts on a card wide enough for all the floors);
// e2e/p4/line-item-widths.spec.ts measures the real pages from 390 to 1440 wide.
describe.each([
  {
    name: 'purchase request',
    file: 'src/app/(app)/procurement/requests/_components/pr-lines.module.css',
    container: /@container \(min-width: (\d+)px\) \{/,
    numeric: [3, 4],
    sideColumns: 40 + 40,
    columns: /\.headFields,\n\s+\.fields \{\n\s+grid-template-columns:([^;]+);/,
  },
  {
    name: 'manual invoice',
    file: 'src/app/(app)/invoices/new/lines-editor.module.css',
    container: /@container \(min-width: (\d+)px\) \{/,
    numeric: [2, 3],
    sideColumns: 56 + 40,
    columns: /\.invoice \.fields \{[^}]*grid-template-columns:([^;]+);/,
  },
])('$name line items', ({ file, container, columns, numeric, sideColumns }) => {
  const css = read(file);

  it('gives every table column a floor, so no column can shrink to nothing', () => {
    const template = columns.exec(css)?.[1] ?? '';
    const floors = columnMinimums(template);
    expect(floors).toHaveLength(5);
    expect(Math.min(...floors)).toBeGreaterThanOrEqual(5.5);
  });

  it('switches to the table on a card wide enough for the floors, not on the window', () => {
    const width = Number(container.exec(css)?.[1]);
    const floors = columnMinimums(columns.exec(css)?.[1] ?? '');
    // The floors, the four 16px gaps, and the line number and remove columns (and their gaps) beside the fields.
    const needed = floors.reduce((sum, rem) => sum + rem * 16, 0) + 4 * 16 + sideColumns + 2 * 12;
    expect(width).toBeGreaterThanOrEqual(needed);
    expect(css).not.toMatch(/@media \(min-width: \d+px\) \{\s*\.invoice \.head/);
  });

  it('keeps room for the number boxes: Quantity and Unit price floors are at least 10rem', () => {
    const floors = columnMinimums(columns.exec(css)?.[1] ?? '');
    // Column order: the number boxes are Quantity and Unit price.
    for (const index of numeric) expect(floors[index]).toBeGreaterThanOrEqual(10);
  });
});
