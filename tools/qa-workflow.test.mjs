// Run: node --test tools/qa-workflow.test.mjs
// A required "qa specs 1/2/3" check must report on every pull request, so the pull_request trigger has no filter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('../.github/workflows/qa.yml', import.meta.url), 'utf8');
const on = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));

test('qa runs on every pull request: no paths or paths-ignore filter on pull_request', () => {
  assert.match(on, /\n {2}pull_request:\s*\n/);
  const afterPr = on.slice(on.indexOf('pull_request:'));
  assert.doesNotMatch(afterPr, /paths(-ignore)?:/);
});

test('the quarantined job stays non-blocking', () => {
  assert.match(text, /continue-on-error: \$\{\{ matrix\.mode == 'quarantined' \}\}/);
});
