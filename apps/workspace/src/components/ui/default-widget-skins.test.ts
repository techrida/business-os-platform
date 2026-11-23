import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// UIP-BUILD-002 (R6Z): the platform's own scrollbar, file row, progress bar, range slider, search
// clear button and number steppers must not show. jsdom has no layout, so this reads the shared
// stylesheets that both apps load; a hand check at 1280 and 390 is in round6/guide/R6Z.html.
// The two apps carry the same block because they cannot import each other's CSS.

const root = join(process.cwd(), '..');
const sheets = {
  workspace: readFileSync(join(root, 'workspace/src/styles/globals.css'), 'utf8'),
  portal: readFileSync(join(root, 'portal/src/styles/globals.css'), 'utf8'),
};
const MARK = '/* ---- Browser-default widgets';

describe.each(Object.entries(sheets))('%s globals.css', (_app, css) => {
  it('has the skin block marker the other checks slice on', () => {
    expect(css.indexOf(MARK)).toBeGreaterThanOrEqual(0);
  });

  it('skins scrollbars with tokens everywhere', () => {
    expect(css).toMatch(
      /\*\s*\{[^}]*scrollbar-width: thin;[^}]*scrollbar-color: var\(--border-strong\) transparent;/,
    );
  });

  it('turns the native file row into a styled secondary button', () => {
    expect(css).toMatch(
      /input\[type='file'\]\)::file-selector-button \{[^}]*var\(--button-secondary-border\)/,
    );
    expect(css).toMatch(/input\[type='file'\]\):disabled::file-selector-button/);
  });

  it('skins progress and meter, range, search clear and number steppers', () => {
    expect(css).toMatch(/progress::-webkit-progress-value[^{]*\{[^}]*var\(--progress-fill-bg\)/);
    expect(css).toMatch(/progress::-moz-progress-bar/);
    expect(css).toMatch(/input\[type='range'\]\)::-webkit-slider-thumb \{/);
    expect(css).toMatch(/input\[type='range'\]\)::-moz-range-thumb \{/);
    expect(css).toMatch(/::-webkit-search-cancel-button/);
    expect(css).toMatch(/::-webkit-inner-spin-button/);
  });

  it('keeps component classes stronger than the type-selector skins', () => {
    const block = css.slice(css.indexOf(MARK));
    // No bare `input[type=...]` selector outside :where(): it would out-rank a component class.
    expect(block.replace(/:where\(input\[[^\]]*\]\)/g, '')).not.toMatch(/(^|[\s,}])input\[type=/m);
  });

  it('never sets outline: none in the skin block, so the focus ring stays', () => {
    expect(css.slice(css.indexOf(MARK))).not.toMatch(/outline:\s*none/);
  });
});

it('both apps carry the identical skin block', () => {
  const block = (css: string) => css.slice(css.indexOf(MARK));
  expect(block(sheets.portal)).toBe(block(sheets.workspace));
});
