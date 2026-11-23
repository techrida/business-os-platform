// Run: node --test tools/check-public-repo.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findProblems } from './check-public-repo.mjs';

const pkg = (license) => JSON.stringify({ name: 'x', license });
const reader = (files) => (f) => files[f] ?? null;

test('a clean tree passes', () => {
  assert.deepEqual(
    findProblems(
      ['package.json', 'a.ts'],
      reader({ 'package.json': pkg('AGPL-3.0-only'), 'a.ts': 'x' }),
    ),
    [],
  );
});

test('internal files, private paths and a wrong license are reported', () => {
  const files = ['AGENTS.md', 'tools/manual-run/run.mjs', 'a.ts', 'b.ts', 'package.json'];
  const out = findProblems(
    files,
    reader({
      'a.ts': 'const d = "/ho' + 'me/someone/work";',
      'b.ts': 'https://box.tail1c0' + '4d9.ts' + '.net',
      'package.json': pkg('MIT'),
    }),
  );
  assert.equal(out.filter((l) => l.includes('internal file')).length, 2);
  assert.ok(out.some((l) => l.startsWith('a.ts:') && l.includes('home-folder')));
  assert.ok(out.some((l) => l.startsWith('b.ts:') && l.includes('tailnet')));
  assert.ok(out.some((l) => l.startsWith('package.json:') && l.includes('license')));
});
