// Run: node --test tools/qa-approve-timing.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_P95_LIMIT_MS,
  limitFrom,
  parseTimings,
  percentile,
  summarise,
  verdict,
} from '../.github/qa/approve-timing.mjs';

test('percentile is nearest-rank', () => {
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(v, 95), 19);
  assert.equal(percentile(v, 50), 10);
  assert.equal(percentile([], 95), undefined);
});

test('parseTimings keeps numeric ms with its outcome and skips torn or foreign lines', () => {
  assert.deepEqual(
    parseTimings(
      '{"ms":10}\n{"ms":\nnope\n{"ms":"x"}\n{"ms":-1}\n\n{"ms":30,"ok":true}\n{"ms":40,"ok":false}\n',
    ),
    [
      { ms: 10, ok: true },
      { ms: 30, ok: true },
      { ms: 40, ok: false },
    ],
  );
});

test('summarise reports succeeded and failed counts, and p50, p95, max of the successes only', () => {
  const ok = (ms) => ({ ms, ok: true });
  const text = summarise([ok(100), ok(200), ok(300), ok(400), { ms: 30_000, ok: false }]);
  assert.equal(text.split('\n')[0], '### Approve to decided page');
  assert.match(text, /\| 4 \| 1 \| 200 ms \| 400 ms \| 400 ms \|/);
  assert.match(text, /1 failed after 30000 ms/);
  assert.match(summarise([]), /No Approve was timed/);
  assert.match(summarise([{ ms: 5, ok: false }]), /\| 0 \| 1 \| n\/a \| n\/a \| n\/a \|/);
});

test('the limit is 80 ms p95, judged on the successful Approves only', () => {
  assert.equal(DEFAULT_P95_LIMIT_MS, 80);
  const ok = (ms) => ({ ms, ok: true });
  const fast = Array.from({ length: 20 }, (_, i) => ok(40 + i)); // 40..59 ms
  assert.equal(verdict(fast).ok, true);
  assert.equal(verdict([...fast, ok(80)]).ok, true, 'exactly at the limit passes');
  const slow = Array.from({ length: 20 }, (_, i) => ok(70 + i)); // p95 = 88 ms
  const over = verdict(slow);
  assert.equal(over.ok, false);
  assert.equal(over.p95, 88);
  // A failed Approve is not in the percentile; a run with no success has nothing to judge.
  assert.equal(verdict([...fast, { ms: 30_000, ok: false }]).ok, true);
  assert.equal(verdict([]).ok, true);
  assert.equal(verdict([{ ms: 30_000, ok: false }]).ok, true);
  assert.equal(verdict(slow, 100).ok, true, 'the limit can be passed in');
});

test('limitFrom reads a positive number and falls back to 80', () => {
  assert.equal(limitFrom('120'), 120);
  for (const bad of [undefined, '', 'x', '0', '-5']) assert.equal(limitFrom(bad), 80, String(bad));
});

test('the summary says whether the p95 is within the limit or fails the job', () => {
  const ok = (ms) => ({ ms, ok: true });
  assert.match(summarise([ok(50), ok(60)]), /p95 60 ms is within the limit of 80 ms/);
  assert.match(
    summarise([ok(50), ok(200)]),
    /p95 200 ms is over the limit of 80 ms: the job fails/,
  );
  assert.match(summarise([]), /No Approve was timed/);
});

test('the command exits 1 over the limit and 0 within it or with no timings', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'approve-timing-'));
  const script = fileURLToPath(new URL('../.github/qa/approve-timing.mjs', import.meta.url));
  const run = (rows, env = {}) => {
    const file = path.join(dir, 'timings.jsonl');
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
    return spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  };
  try {
    assert.equal(run([{ ms: 50, ok: true }]).status, 0);
    const slow = run([{ ms: 200, ok: true }]);
    assert.equal(slow.status, 1);
    assert.match(slow.stdout, /over the limit of 80 ms/);
    assert.match(slow.stderr, /::error::Approve p95 200 ms is over the limit of 80 ms/);
    assert.equal(run([{ ms: 200, ok: true }], { BOS_APPROVE_P95_LIMIT_MS: '250' }).status, 0);
    assert.equal(run([]).status, 0);
    const missing = spawnSync(process.execPath, [script, path.join(dir, 'nope.jsonl')], {
      encoding: 'utf8',
    });
    assert.equal(missing.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the qa workflow prints the summary to the job summary and fails the job over the limit', () => {
  const qa = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
  const start = qa.indexOf('- name: Approve to decided page');
  const step = qa.slice(start, qa.indexOf('\n      - name:', start + 10));
  assert.match(
    step,
    /if: \$\{\{ !cancelled\(\) && \(github\.base_ref == 'main' \|\| \(github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\) \|\| github\.event_name == 'workflow_dispatch'\) \}\}/,
  );
  assert.match(step, /approve-timing\.mjs/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(step, /continue-on-error/);
  assert.match(step, /BOS_APPROVE_P95_LIMIT_MS: \$\{\{ vars\.QA_APPROVE_P95_LIMIT_MS \}\}/);
});

test('the fixture measures from a ready Approve click through visible confirmation', () => {
  const fixture = readFileSync(
    new URL('../apps/workspace/e2e/helpers/fixture-flow.ts', import.meta.url),
    'utf8',
  );
  const steps = [
    'await button.click({ trial: true })',
    'const clicked = Date.now()',
    'await button.click()',
    "await expect(page.getByText('Your approval was recorded.')).toBeVisible()",
    'recordApproveTiming(Date.now() - clicked, true)',
  ];
  let previous = -1;
  for (const step of steps) {
    const index = fixture.indexOf(step);
    assert.ok(index > previous, step);
    previous = index;
  }
});
