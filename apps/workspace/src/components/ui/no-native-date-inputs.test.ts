import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// UIP-FORM-004/005: a date is picked with the app's DatePicker (or DateTimePicker), never with the
// browser's native `type="date"`, `"datetime-local"` or `"time"` box, whose look, language and
// keyboard behaviour differ by browser. The Bikram Sambat line lives in DatePicker, so a native box
// also loses it.

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const NATIVE = /\btype=(?:"|'|\{\s*['"])(?:date|datetime-local|time|month|week)\b/;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * Files that still hold a native date box, left for the units that own their money and quantity
 * fields (FX5 and FX6). Remove a path from this list when its file moves to DatePicker; the test
 * below fails if a file here no longer needs to be listed, and if any other file gains a native box.
 */
const DEFERRED = [
  'apps/portal/src/app/(portal)/payments/_components/payment-form.tsx',
  'apps/workspace/src/app/(app)/invoices/_components/invoice-filters.tsx',
];

const withNativeBox = ['apps/workspace/src', 'apps/portal/src']
  .flatMap((dir) => sources(join(repo, dir)))
  // The pickers' own hidden form fields are made by react-aria, and their docs name the old input.
  .filter((file) => !file.endsWith('date-picker.tsx'))
  .filter((file) => NATIVE.test(readFileSync(file, 'utf8')))
  .map((file) => relative(repo, file).split(sep).join('/'))
  .sort();

it('no file holds a native date input except the ones deferred to FX5 and FX6', () => {
  expect(withNativeBox.filter((file) => !DEFERRED.includes(file))).toEqual([]);
});

it('every deferred file still needs its entry', () => {
  expect(DEFERRED.filter((file) => !withNativeBox.includes(file))).toEqual([]);
});

it('the files this unit moved hold no native date input', () => {
  for (const file of [
    'apps/workspace/src/components/p2/crm/schedule-follow-up-dialog.tsx',
    'apps/workspace/src/components/p2/crm/lead-form.tsx',
    'apps/portal/src/app/(vendor)/vendor/onboarding/upload/_components/kyc-form.tsx',
  ]) {
    expect(NATIVE.test(readFileSync(join(repo, file), 'utf8')), file).toBe(false);
  }
});
