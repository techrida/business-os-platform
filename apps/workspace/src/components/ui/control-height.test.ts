import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * UIP-FORM-010: every control in a row has one height at each size. Mouse and keyboard screens use 42px; touch screens
 * (`pointer: coarse`) use 44px for all of them, so the phone box, its label select and a text box beside them never
 * differ. Reads the stylesheets as text, so it cannot see a control that is not listed.
 */
const ui = dirname(fileURLToPath(import.meta.url));

function css(file: string): string {
  return readFileSync(resolve(ui, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The `min-height` of `selector` outside any media query (`coarse: false`) or inside the touch one (`true`). */
function minHeight(file: string, selector: string, coarse: boolean): string | undefined {
  const text = css(file);
  const start = text.indexOf('@media (pointer: coarse)');
  const end = start === -1 ? -1 : text.indexOf('\n}', start);
  const scope = coarse
    ? start === -1
      ? ''
      : text.slice(start, end)
    : start === -1
      ? text
      : text.slice(0, start) + text.slice(end);
  for (const m of scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      !(m[1] ?? '')
        .split(',')
        .some((s) => s.trim().endsWith(selector) || s.trim().endsWith(`${selector}:not(.textarea)`))
    )
      continue;
    const found = /min-height:\s*([^;]+);/.exec(m[2] ?? '');
    if (found) return found[1]?.trim();
  }
  return undefined;
}

const CONTROLS: [file: string, selector: string][] = [
  ['field.module.css', '.control'],
  ['select.module.css', '.trigger'],
  ['phone-field.module.css', '.box'],
];

describe('control heights (UIP-FORM-010)', () => {
  it.each(CONTROLS)('%s %s is 42px by default', (file, selector) => {
    expect(minHeight(file, selector, false)).toBe('42px');
  });

  it.each(CONTROLS)('%s %s is 44px on touch', (file, selector) => {
    expect(minHeight(file, selector, true)).toBe('44px');
  });
});

describe('image upload hint (R6AC)', () => {
  it('never hides the size hint at a narrow width; only the drag half goes', () => {
    const text = css('image-upload.module.css');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const hidden = /display:\s*none/.test(m[2] ?? '');
      if (hidden) expect(m[1]).not.toMatch(/\.dropHint\b/);
    }
    expect(text).toMatch(/\.dropHow\s*\{[^}]*display:\s*none/);
  });
});

describe('field help button (R6C5)', () => {
  it('is never hidden at any width', () => {
    const text = css('field.module.css');
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/\.help\b/.test(m[1] ?? ''))
        expect(m[2]).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
  });
});
