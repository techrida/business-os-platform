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

it('makes the board a visible, sideways scroll container with fixed-width columns', () => {
  const board = rule(crm, '.board');
  expect(board).toMatch(/overflow-x: auto;/);
  expect(board).toMatch(/grid-auto-columns: 280px;/);
  expect(board).toMatch(/overscroll-behavior-x: contain;/);
  // Classic scrollbar, so it is drawn even where the platform uses overlay scrollbars.
  expect(board).toMatch(/scrollbar-width: auto;/);
  expect(crm).toMatch(/\.board::-webkit-scrollbar \{[^}]*height: \d+px;/);
});

it('draws edge fades over the board only while columns are hidden on that side', () => {
  expect(rule(crm, '.boardFrame::before')).toMatch(/linear-gradient/);
  expect(rule(crm, '.boardFrame::after')).toMatch(/linear-gradient/);
  expect(crm).toMatch(/\.boardFrame\[data-more-left='true'\]::before,/);
  expect(crm).toMatch(/\.boardFrame\[data-more-right='true'\]::after \{\s*opacity: 1;/);
});

it('scrolls each column on its own under a header that stays put', () => {
  expect(rule(crm, '.column')).toMatch(/max-height: calc\(var\(--board-height\)/);
  expect(rule(crm, '.cards')).toMatch(/overflow-y: auto;/);
  expect(rule(crm, '.columnHead')).toMatch(/flex: none;/);
});

it('snaps one column per view on a phone, and stops snapping while a card is dragged', () => {
  const afterCards = crm.slice(crm.indexOf('.cards {'));
  const phone = /@media \(max-width: 767\.98px\) \{([\s\S]*?)\n\}\n/.exec(afterCards)?.[1] ?? '';
  expect(phone).toMatch(/scroll-snap-type: x mandatory;/);
  expect(phone).toMatch(/\.board\[data-dragging='true'\] \{\s*scroll-snap-type: none;/);
  expect(phone).toMatch(/scroll-snap-align: start;/);
});
