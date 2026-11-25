// Run: node --test tools/qa-spec-counts.test.mjs
// A mistyped spec filter makes both Playwright steps pass with no tests (--pass-with-no-tests). The check must fail then.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decide, parseTotal } from '../.github/qa/spec-counts.mjs';

test('parseTotal reads the last Total line of a --list output', () => {
  assert.equal(parseTotal('Listing tests:\n  a.spec.ts:1:1 › x\nTotal: 37 tests in 6 files\n'), 37);
  assert.equal(parseTotal('Listing tests:\nTotal: 0 tests in 0 files'), 0);
  assert.equal(parseTotal('Total: 1 test in 1 file\n'), 1);
  assert.equal(parseTotal('no summary'), undefined);
});

test('a filter that matches no test in either suite fails', () => {
  const v = decide({ filter: 'p4/lst-filters', wsTotal: 0, portalTotal: 0 });
  assert.equal(v.ok, false);
  assert.match(v.message, /p4\/lst-filters/);
});

test('a filter that matches in one suite only passes (the other step is meant to be empty)', () => {
  assert.equal(decide({ filter: 'p4/list-filters', wsTotal: 5, portalTotal: 0 }).ok, true);
  assert.equal(decide({ filter: 'journey-11', wsTotal: 0, portalTotal: 3 }).ok, true);
});

test('no filter never fails here', () => {
  assert.equal(decide({ filter: '  ', wsTotal: 0, portalTotal: 0 }).ok, true);
});

test('the qa workflow runs the check with the filter before the Playwright steps', () => {
  const text = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
  const check = text.indexOf('node .github/qa/spec-counts.mjs');
  assert.ok(check > 0);
  assert.ok(check < text.indexOf('- name: Playwright (workspace, dev project)'));
});
