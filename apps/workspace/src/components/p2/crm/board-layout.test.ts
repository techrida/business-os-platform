import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const crm = readFileSync(join(process.cwd(), 'src/components/p2/crm/crm.module.css'), 'utf8');
const shell = readFileSync(join(process.cwd(), 'src/components/shell/shell.module.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

// jsdom has no layout. The board's wrapper is a grid item of the page; with the default
// `min-width: auto` it could not shrink below every column side by side, so the whole app (sidebar
// and header too) scrolled sideways instead of the board (Kuu, 2026-11-23). e2e/p2/board-scroll.spec.ts
// measures the real page; this pins the three declarations that fix it.
it('lets the board wrapper shrink so the board, not the page, scrolls', () => {
  expect(rule(crm, '.boardRoot')).toMatch(/min-width: 0;/);
});

it('never lets the shell itself scroll sideways', () => {
  expect(rule(shell, '.frame')).toMatch(/overflow-x: clip;/);
  expect(rule(shell, '.column')).toMatch(/overflow-x: clip;/);
});
