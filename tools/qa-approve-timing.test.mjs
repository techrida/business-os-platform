// Run: node --test tools/qa-approve-timing.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseTimings, percentile, summarise } from '../.github/qa/approve-timing.mjs';

test('percentile is nearest-rank', () => {
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 19);
  assert.equal(percentile(v, 50), 10);
  assert.equal(percentile([], 95), undefined);
});

test('parseTimings keeps numeric ms and skips torn or foreign lines', () => {
  assert.deepEqual(
    parseTimings('{"ms":10}\n{"ms":\nnope\n{"ms":"x"}\n{"ms":-1}\n\n{"ms":30}\n'),
    [10, 30],
  );
});

test('summarise reports samples, p50, p95 and max, and says so when nothing was timed', () => {
  const text = summarise([100, 200, 300, 400]);
  assert.match(text, /\| 4 \| 200 ms \| 400 ms \| 400 ms \|/);
  assert.match(summarise([]), /No Approve was timed/);
});

test('the qa workflow prints the summary to the job summary and never fails on it', () => {
  const qa = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
  const step = qa.slice(qa.indexOf('- name: Approve timing (p95 in the job summary)'));
  assert.match(step, /approve-timing\.mjs/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.match(step.slice(0, step.indexOf('\n      - name:', 10)), /continue-on-error: true/);
});
