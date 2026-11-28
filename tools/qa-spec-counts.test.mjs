// Run: node --test tools/qa-spec-counts.test.mjs
// A mistyped spec filter makes both Playwright steps pass with no tests (--pass-with-no-tests). The check must fail then.
import assert from 'node:assert/strict';
import { partition, matrix } from './qa-shards.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  checkLists,
  decide,
  parseSpecFiles,
  parseTotal,
  skipPattern,
} from '../.github/qa/spec-counts.mjs';

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

test('skipPattern adds the quarantine only when it has content', () => {
  assert.equal(skipPattern(''), 'persona sign-in and sign-out|qa fixtures: ');
  assert.equal(skipPattern('\n'), 'persona sign-in and sign-out|qa fixtures: ');
  assert.equal(skipPattern('a|b\n'), 'persona sign-in and sign-out|qa fixtures: |a|b');
});

test('parseSpecFiles reads the files out of a --list output', () => {
  const out = [
    'Listing tests:',
    '  [dev] › exit.spec.ts:12:5 › exit › a',
    '  [dev] › p4/orders.spec.ts:30:7 › orders › b',
    '  [dev] › p4/orders.spec.ts:44:7 › orders › c',
    'Total: 3 tests in 2 files',
  ].join('\n');
  assert.deepEqual([...parseSpecFiles(out)].sort(), ['exit.spec.ts', 'p4/orders.spec.ts']);
});

test('checkLists fails on a spec in no list, a spec in both, and a list entry that is not a spec', () => {
  const specFiles = new Set(['a.spec.ts', 'p4/b.spec.ts', 'p4/c.spec.ts']);
  assert.equal(
    checkLists({
      specFiles,
      lists: { x: ['e2e/a.spec.ts', ''], y: ['e2e/p4/b.spec.ts', 'e2e/p4/c.spec.ts'] },
    }).ok,
    true,
  );
  const missing = checkLists({
    specFiles,
    lists: { x: ['e2e/a.spec.ts'], y: ['e2e/p4/b.spec.ts'] },
  });
  assert.deepEqual(missing.problems, ['p4/c.spec.ts is in no shard list']);
  const twice = checkLists({
    specFiles,
    lists: {
      x: ['e2e/a.spec.ts', 'e2e/p4/b.spec.ts'],
      y: ['e2e/p4/b.spec.ts', 'e2e/p4/c.spec.ts'],
    },
  });
  assert.deepEqual(twice.problems, ['p4/b.spec.ts is listed twice (x and y)']);
  const stale = checkLists({
    specFiles,
    lists: {
      x: ['e2e/a.spec.ts', 'e2e/gone.spec.ts'],
      y: ['e2e/p4/b.spec.ts', 'e2e/p4/c.spec.ts'],
    },
  });
  assert.deepEqual(stale.problems, ['gone.spec.ts (x) is not a spec the run executes']);
});

test('checkLists rejects blank and padded lines, which Playwright would read as match-everything and match-nothing', () => {
  const specFiles = new Set(['a.spec.ts', 'b.spec.ts']);
  const bad = (lines) => checkLists({ specFiles, lists: { x: lines, y: ['e2e/b.spec.ts'] } });
  assert.equal(bad(['e2e/a.spec.ts', '']).ok, true, 'the piece after the final newline is fine');
  assert.equal(bad(['e2e/a.spec.ts ', '']).ok, false, 'trailing space');
  assert.equal(bad(['e2e/a.spec.ts\r', '']).ok, false, 'CRLF');
  assert.equal(bad(['', 'e2e/a.spec.ts', '']).ok, false, 'blank line inside');
  assert.match(bad([' e2e/a.spec.ts']).problems[0], /blank or padded line/);
});

test('the committed shard lists cover every dev-project spec file exactly once (offline, by the file system)', () => {
  const e2e = new URL('../apps/workspace/e2e/', import.meta.url);
  const all = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(new URL(dir, e2e), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.spec.ts')) all.push(`${prefix}${entry.name}`);
    }
  };
  walk('', '');
  // Other Playwright projects (ui, prod), and the qa-fixtures specs that the workflow runs in their own step.
  const dev = all.filter(
    (f) =>
      !f.startsWith('ui-harness/') &&
      !['prod-no-switcher.spec.ts', 'lcp.spec.ts'].includes(f) &&
      !/^p4\/qa-fixtures/.test(f),
  );
  const seconds = JSON.parse(readFileSync(new URL('../.github/qa/spec-seconds.json', import.meta.url)));
  for (const count of [6, 10, 14]) {
    const buckets = partition(seconds, count);
    assert.ok(buckets.every(({ files }) => files.length));
    const lists = Object.fromEntries(buckets.map(({ files }, i) => [i, files]));
    assert.deepEqual(checkLists({ specFiles: new Set(dev), lists }).problems, []);
    const result = matrix({ include: [{ ws: true, portal: true, mode: 'specs' }] }, count);
    assert.equal(result.include.length, count);
    assert.equal(result.include.filter((job) => job.portal).length, 1);
  }
});
