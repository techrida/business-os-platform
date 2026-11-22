import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/(app)/inbox/inbox.module.css'), 'utf8');

// jsdom has no layout, so this pins the rule that keeps the page inside the viewport; the
// e2e check in e2e/inbox.spec.ts measures the real page at 390 and 834 wide.
it('positions the table wrapper so its hidden Actions header scrolls with the table, not the page', () => {
  expect(css).toMatch(/\n\.tableCard \.table \{[^}]*position: relative;/);
});
