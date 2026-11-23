import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * CSS contract for UIP-FORM-010. A `Field` is label row, box, then one reserved message line, so a
 * row that bottom-aligns a Button (or a bare box or text) beside Fields would put it level with the
 * message line, about 24px under the input box. This reads the stylesheets as text: it catches a
 * listed row that bottom-aligns without the offset rule, or that lost it. It does not render
 * anything, so it cannot see a row that is not listed here.
 *
 * Rows with no `Field` beside the control are left out on purpose, because the offset would lift
 * the control above its neighbour:
 * - components/access/area-cards.module.css `.addPair` (own label + Select, no message line)
 * - app/(app)/opportunities/[id]/detail.module.css `.stageControls form` (no form is rendered)
 * - app/(app)/activities/activities.module.css `.toolbar`, `.filters` (FilterBar controls, no Field)
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FIELD_TAIL = /calc\(\s*var\(--line-height-caption\)\s*\+\s*8px\s*\)/;
const BOTTOM_ALIGNED = /align-items:\s*(?:flex-)?end\b/;
const BOTTOM_MARGIN = /margin-(?:block-end|bottom):\s*([^;]+);/;

interface Block {
  selectors: string[];
  body: string;
}

function blocks(file: string): Block[] {
  const css = readFileSync(resolve(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Block[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.push({
      selectors: (match[1] ?? '').split(',').map((s) => s.trim()),
      body: match[2] ?? '',
    });
  }
  return found;
}

function bodies(file: string, selector: string): string[] {
  return blocks(file)
    .filter((b) => b.selectors.includes(selector))
    .map((b) => b.body);
}

/** Row selector, and the selector of the control that needs the offset beside the Fields. */
const ROWS: { file: string; row: string; control: string }[] = [
  {
    file: 'app/(app)/settings/_components/settings.module.css',
    row: '.scheduleRow',
    control: '.scheduleRow > button',
  },
  {
    file: 'app/(app)/verification/verification.module.css',
    row: '.dateField',
    control: '.dateField > button',
  },
  {
    file: 'app/(app)/invoices/vat-register/vat-register.module.css',
    row: '.filter',
    control: '.filter > button',
  },
  {
    file: 'app/(app)/payables/payables.module.css',
    row: '.filter',
    control: '.filter > button',
  },
  {
    file: 'app/(app)/settings/workflows/workflows.module.css',
    row: '.addRow',
    control: '.addRow > * + button',
  },
  {
    file: 'app/(app)/settings/access/roles/roles.module.css',
    row: '.tools',
    control: '.check',
  },
  {
    file: 'components/settings/lost-reasons/lost-reasons.module.css',
    row: '.edit',
    control: '.edit > .actions',
  },
  {
    file: 'components/departments/departments.module.css',
    row: '.toolbar',
    control: '.toolbarFilter',
  },
  {
    file: 'app/(app)/invoices/_components/notes/notes.module.css',
    row: '.creditLine',
    control: '.creditText',
  },
];

describe('rows that put a control beside Fields (UIP-FORM-010)', () => {
  it.each(ROWS)('$file $row: bottom-aligned only with the message-line offset', (spec) => {
    const rowBodies = bodies(spec.file, spec.row);
    expect(rowBodies.length, `${spec.row} not found in ${spec.file}`).toBeGreaterThan(0);
    const bottomAligned = rowBodies.some((body) => BOTTOM_ALIGNED.test(body));
    expect(bottomAligned, `${spec.row} should still bottom-align the control with the box`).toBe(
      true,
    );
    const offset = bodies(spec.file, spec.control)
      .map((body) => BOTTOM_MARGIN.exec(body)?.[1] ?? '')
      .filter((value) => FIELD_TAIL.test(value));
    expect(
      offset.length,
      `${spec.control} needs margin-block-end: calc(var(--line-height-caption) + 8px)`,
    ).toBeGreaterThan(0);
  });

  it('keeps the Fields-only settings form row top-aligned, with no stale hint comment', () => {
    const file = 'app/(app)/settings/_components/settings.module.css';
    const row = bodies(file, '.formRow');
    expect(row.length).toBeGreaterThan(0);
    for (const body of row) {
      expect(body).not.toMatch(BOTTOM_ALIGNED);
      expect(body).toMatch(/align-items:\s*start/);
    }
    const raw = readFileSync(resolve(src, file), 'utf8');
    expect(raw).not.toContain('hint line above its control');
  });

  it('places the lost-reasons Add button below the label row, not at a fixed 22px', () => {
    const file = 'components/settings/lost-reasons/lost-reasons.module.css';
    const tops = bodies(file, '.add > button').join('\n');
    expect(tops).not.toMatch(/margin-block-start:\s*22px/);
    expect(tops).toMatch(
      /margin-block-start:\s*calc\(var\(--line-height-body-small\)\s*\+\s*8px\)/,
    );
  });
});
