import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

// Importing the menu mounts it, so read its shadow styles as text. The shell's breakpoints
// (shell.module.css) put the rail at 768-1023px and the full sidebar from 1024px.
const source = readFileSync(join(process.cwd(), 'src/dev/dev-menu.ts'), 'utf8');

it('keeps the Dev chip beside the rail on a tablet, clear of its Settings link', () => {
  expect(source).toMatch(
    /@media \(min-width: 768px\) \{\s*\.root \{ left: calc\(var\(--bos-rail-width, 108px\) \+ 12px\); \}/,
  );
});

it('keeps the Dev chip beside the full sidebar on a laptop', () => {
  expect(source).toMatch(
    /@media \(min-width: 1024px\) \{\s*\.root \{ left: calc\(var\(--bos-sidebar-width, 220px\) \+ 12px\); \}/,
  );
});
