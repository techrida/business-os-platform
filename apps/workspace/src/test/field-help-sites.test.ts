import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

/**
 * UIP-FORM-010: an error replaces the hint in the one message line. A hint that says HOW to fill the field would be
 * lost the moment its field fails, so these Fields also pass `help`, the info button beside the label whose tooltip
 * keeps the instruction. Source contract: the Field's own tag names `help` next to the hint and the error.
 */
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../app/(app)');

const SITES: { file: string; hint: RegExp; what: string }[] = [
  {
    file: 'procurement/receipts/_components/receipt-form.tsx',
    hint: /label=\{lineLabel\('Serial numbers'\)\}\s+hint="[^"]+"\s+help="[^"]+"\s+error=/,
    what: 'receipt serial numbers',
  },
  {
    file: 'payments/new/payment-form.tsx',
    hint: /label="Withholding code"\s+hint="[^"]+"\s+help="[^"]+"\s+error=/,
    what: 'tax-withheld (withholding) code',
  },
  {
    file: 'payments/new/payment-form.tsx',
    hint: /label="Tax withheld"\s+optional\s+hint="[^"]+"\s+help="[^"]+"\s+error=/,
    what: 'tax withheld amount',
  },
  {
    file: 'procurement/rfqs/_components/decision-forms.tsx',
    hint: /label="If fewer quotations than required"\s+optional\s+hint="[^"]+"\s+help="[^"]+"\s+error=/,
    what: 'procurement decision form: fewer-quotations reason',
  },
  {
    file: 'procurement/rfqs/_components/decision-forms.tsx',
    hint: /label="New quotation deadline"\s+hint="[^"]+"\s+help="[^"]+"\s+error=/,
    what: 'procurement decision form: new deadline',
  },
];

it.each(SITES)(
  'keeps the $what instruction reachable when an error takes the hint line',
  (site) => {
    const source = readFileSync(resolve(app, site.file), 'utf8');
    expect(source).toMatch(site.hint);
  },
);
