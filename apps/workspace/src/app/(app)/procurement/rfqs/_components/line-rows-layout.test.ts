import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(process.cwd(), 'src/app/(app)/procurement/rfqs/_components/line-rows.module.css'),
  'utf8',
);

/** The floor of each `minmax(<floor>, …)` column in a template, in rem (a `minmax(0, …)` column counts as 0). */
const floors = (template: string): number[] =>
  [...template.matchAll(/minmax\((\d+(?:\.\d+)?)(?:rem)?,/g)].map((m) => Number(m[1]));

// jsdom has no layout. The quotation and receipt line rows had `minmax(0, …)` columns from a 760px card,
// so Quantity measured 30px at 1280 and 50px at 1440 (a number box keeps about 7rem of unit, steppers
// and padding around its input). e2e/p4/line-item-widths.spec.ts measures the real pages.
describe.each([
  { name: 'quotation', rule: 'quote', numeric: [1, 2] },
  { name: 'receipt', rule: 'receipt', numeric: [1] },
])('$name line rows', ({ rule, numeric }) => {
  const template =
    new RegExp(
      `\\.${rule} :is\\(\\.headFields, \\.fields\\) \\{\\s*grid-template-columns:([^;]+);`,
    ).exec(css)?.[1] ?? '';
  const columns = floors(template);

  it('gives every column a floor, so none can shrink to nothing', () => {
    expect(columns).toHaveLength(4);
    expect(Math.min(...columns)).toBeGreaterThanOrEqual(8);
  });

  it('keeps 12.5rem for each number box, so its input stays readable', () => {
    for (const index of numeric) expect(columns[index]).toBeGreaterThanOrEqual(12.5);
  });

  it('switches to the row layout only on a card wide enough for all the floors', () => {
    const width = Number(/@container \(min-width: (\d+)rem\)/.exec(css)?.[1]) * 16;
    // Floors, three 16px gaps, and the line number column with its gap.
    const needed = columns.reduce((sum, rem) => sum + rem * 16, 0) + 3 * 16 + 40 + 12;
    expect(width).toBeGreaterThanOrEqual(needed);
  });

  it('stacks the fields in columns wide enough for a number box too', () => {
    const stacked = /\.fields \{[^}]*minmax\(min\(100%, (\d+(?:\.\d+)?)rem\)/.exec(css)?.[1];
    expect(Number(stacked)).toBeGreaterThanOrEqual(12.5);
  });
});
