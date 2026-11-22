import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// UIP-FORM-004/005: these RFQ and vendor bill forms pick dates with the app's DatePicker or
// DateTimePicker, not the browser's native date box.
const repo = fileURLToPath(new URL('../../../../../../../../', import.meta.url));
const NATIVE = /\btype=(?:"|'|\{\s*['"])(?:date|datetime-local|time|month|week)\b/;

it.each([
  'apps/workspace/src/app/(app)/procurement/rfqs/_components/decision-forms.tsx',
  'apps/workspace/src/app/(app)/procurement/rfqs/_components/rfq-form.tsx',
  'apps/portal/src/app/(vendor)/vendor/bills/new/_components/bill-form.tsx',
  'apps/portal/src/app/(vendor)/vendor/rfqs/[id]/quote/_components/quote-form.tsx',
])('%s holds no native date input', (file) => {
  expect(NATIVE.test(readFileSync(join(repo, file), 'utf8'))).toBe(false);
});
