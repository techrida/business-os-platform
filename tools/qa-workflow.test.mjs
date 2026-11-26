// Run: node --test tools/qa-workflow.test.mjs
// The required `qa required` check must report on every pull request, so the pull_request trigger has no filter.
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

test('qa required always reports and needs every job; the matrix comes from the change detection', () => {
  assert.match(
    text,
    /qa-required:\n {4}name: qa required\n {4}if: \$\{\{ always\(\) \}\}\n {4}needs: \[changes, workspace\]/,
  );
  assert.match(text, /matrix: \$\{\{ fromJSON\(needs\.changes\.outputs\.qa-matrix\) \}\}/);
});

test('ci required always reports and needs every ci job', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(
    ci,
    /ci-required:\n {4}name: ci required\n {4}if: \$\{\{ always\(\) \}\}\n {4}needs: \[changes, checks, secrets, e2e, web, docker\]/,
  );
});

test('the tools tests run from a glob that includes tools/policy, in ci.yml and in tools/gate.sh', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('./gate.sh', import.meta.url), 'utf8');
  for (const [name, source] of [
    ['ci.yml', ci],
    ['tools/gate.sh', gate],
  ]) {
    const line = source.split('\n').find((l) => l.includes('node --test'));
    assert.ok(line, `${name} has a node --test line`);
    // Quoted, so node (not the shell) expands them: an unmatched pattern is then ignored instead of passed on literally.
    assert.match(line, /"tools\/\*\.test\.mjs"/, name);
    assert.match(line, /"tools\/policy\/\*\.test\.mjs"/, name);
    assert.doesNotMatch(line, /tools\/(affected|qa-[a-z-]+|check-public-repo)\.test\.mjs/, name);
  }
});

test('the workspace step runs its shard from a file list; a spec filter falls back to Playwright --shard', () => {
  const step = text.slice(text.indexOf('- name: Playwright (workspace, dev project)'));
  const run = step.slice(0, step.indexOf('\n      - name:', 10));
  assert.match(run, /LIST: \$\{\{ matrix\.list \}\}/);
  assert.match(run, /mapfile -t targets < "\.\.\/\.\.\/\.github\/qa\/\$LIST\.txt"/);
  assert.match(run, /--shard="\$SHARD"/);
});

test('the portal specs run on the job the matrix marks, and the shard lists are checked before the stack comes up', () => {
  assert.match(
    text,
    /- name: Portal specs[^\n]*\n {8}if: \$\{\{ !cancelled\(\) && matrix\.mode == 'specs' && matrix\.portal \}\}/,
  );
  const check = text.indexOf('node .github/qa/spec-counts.mjs --lists');
  assert.ok(check > 0 && check < text.indexOf('bash .github/qa/up.sh'));
});

test('no workflow still talks about three shards', () => {
  assert.doesNotMatch(text, /specs 1\/2\/3|Three shards|1\/3/);
});
