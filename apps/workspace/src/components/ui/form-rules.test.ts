import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// UIP-FORM-008 / UIP-FORM-009 guard. Scans the source of both apps and fails on:
//  1. a string that starts "Optional." or "Optional," (helper text that only says the field is optional);
//  2. "(optional)" written into a label (the marker is `<Field optional>`);
//  3. a PAN box that renders a "n of 9" counter (fixed-format fields report errors only when wrong);
//  4. a Search button inside a form file (pickers search as you type, UIP-FORM-009).
// It does NOT catch a format-only hint worded some other way, or a picker built from a plain select without a
// button; those stay with review (UIP-FORM-009 review check).

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

const files = ['apps/workspace/src', 'apps/portal/src']
  .flatMap((dir) => sources(join(repo, dir)))
  .map((file) => ({
    file: relative(repo, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }));

const hits = (pattern: RegExp) =>
  files.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

/**
 * Files owned by other round-6 units that still hold the old wording (lead form: R6O; convert dialog: R6T). Remove an
 * entry when its file moves; the last test fails when an entry no longer needs listing.
 */
const OTHER_UNITS = [
  'apps/workspace/src/components/p2/crm/lead-form.tsx',
  'apps/workspace/src/components/p2/crm/convert-dialog.tsx',
];

const OPTIONAL_HINT = /['"`]Optional[.,]/;
const OPTIONAL_LABEL = /\(optional\)/i;
const SEARCH_BUTTON = /<Button\b[\s\S]{0,400}?>\s*\{?[^<>]*\bSearch(?:ing)?\b[^<>]*<\/Button>/;

/** Files still to move; the second test fails when an entry no longer needs listing. */
const SEARCH_BUTTON_DEFERRED = ['apps/workspace/src/components/p2/crm/convert-dialog.tsx'];

it('no helper text only says "Optional."', () => {
  expect(hits(OPTIONAL_HINT).filter((f) => !OTHER_UNITS.includes(f))).toEqual([]);
});

it('no label spells "(optional)": the Field marker does that', () => {
  expect(hits(OPTIONAL_LABEL).filter((f) => !OTHER_UNITS.includes(f))).toEqual([]);
});

it('the PAN box shows no n-of-9 counter', () => {
  const pan = files.find(({ file }) => file.endsWith('components/ui/pan-input.tsx'));
  expect(pan?.text).toBeDefined();
  expect(/\bcount\s*[:(]/.test((pan?.text ?? '').replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
});

it('no Search button sits in a form beside a picker', () => {
  expect(hits(SEARCH_BUTTON).filter((f) => !SEARCH_BUTTON_DEFERRED.includes(f))).toEqual([]);
});

it('every deferred Search-button file still needs its entry', () => {
  expect(SEARCH_BUTTON_DEFERRED.filter((f) => !hits(SEARCH_BUTTON).includes(f))).toEqual([]);
});

it('every other-unit file still needs its entry', () => {
  expect(OTHER_UNITS.filter((f) => !hits(OPTIONAL_HINT).includes(f))).toEqual([]);
});
