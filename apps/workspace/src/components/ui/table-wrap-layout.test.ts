import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/components/ui/table.module.css'), 'utf8');

// jsdom has no layout. The shared table's wrapper scrolls sideways, but its visually hidden header
// cell (`position: absolute`) was positioned against the page, so a list with an "Actions" column
// scrolled the whole page at 390 and 834px (the /inbox bug, fixed there first). The wrapper must
// be the containing block. e2e/p4/line-item-widths.spec.ts and e2e/inbox.spec.ts measure real pages.
it('makes the scrolling table wrapper the containing block for hidden cells', () => {
  const wrap = /(?:^|\n)\.wrap \{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(wrap).toMatch(/overflow-x: auto;/);
  expect(wrap).toMatch(/position: relative;/);
});

// A clipped last column (the RFQ Quotations table's Score at 834px) must show that the table scrolls:
// overlay scrollbars stay hidden until touched, a styled one is always drawn.
it('draws a visible scrollbar on the table wrapper', () => {
  // Standard properties: Chrome ignores ::-webkit-scrollbar once globals.css sets scrollbar-color.
  expect(css).toMatch(
    /\.wrap \{[^}]*scrollbar-color: var\(--border-strong\) var\(--surface-muted\);/,
  );
  expect(css).not.toMatch(/::-webkit-scrollbar/);
});
