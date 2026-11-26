// Run: node --test tools/affected-skip.test.mjs
// The same-commit skip is the gate: a wrong skip would let an untested commit pass. These tests run the real selector
// against a local stand-in for the Actions API, with fixtures for every run state it must never skip on.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nothingToRun, sameCommitGreen } from './affected.mjs';

const SHA = 'a'.repeat(40);
const run = (over) => ({
  id: 1,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  head_sha: SHA,
  ...over,
});

test('sameCommitGreen: only a finished, successful push run of this commit counts', () => {
  const check = (runs, over = {}) =>
    sameCommitGreen({ runs, sha: SHA, currentRunId: '99', ...over });
  assert.equal(check([run({})]), true);
  assert.equal(
    check([run({ conclusion: 'failure' }), run({ id: 2 })]),
    true,
    'one green is enough',
  );
  // Never on these:
  assert.equal(check([]), false, 'no earlier run');
  assert.equal(check([run({ conclusion: 'failure' })]), false, 'failed');
  assert.equal(check([run({ conclusion: 'cancelled' })]), false, 'cancelled');
  assert.equal(check([run({ conclusion: 'timed_out' })]), false, 'timed out');
  assert.equal(check([run({ conclusion: null, status: 'in_progress' })]), false, 'in progress');
  assert.equal(check([run({ conclusion: 'skipped' })]), false, 'skipped');
  assert.equal(
    check([run({ event: 'pull_request' })]),
    false,
    'a pull request run may have tested a subset',
  );
  assert.equal(check([run({ event: 'workflow_dispatch' })]), false, 'a manual run');
  assert.equal(check([run({ event: 'schedule' })]), false, 'a scheduled run');
  assert.equal(check([run({ head_sha: 'b'.repeat(40) })]), false, 'another commit');
  assert.equal(check([run({ id: 99 })]), false, 'the current run is not an earlier run');
  assert.equal(check([run({})], { sha: '' }), false, 'no sha');
});

test('nothingToRun selects nothing at all', () => {
  const r = nothingToRun('x');
  assert.equal(r.skip, true);
  for (const [k, v] of Object.entries(r))
    if (!['skip', 'reason', 'packages'].includes(k)) assert.equal(v, false, k);
  assert.deepEqual(r.packages, []);
});

// The selector as the workflow runs it, against a fake Actions API.
let server;
let base;
let answer = { status: 200, body: { workflow_runs: [] } };
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function select({ event, runs, status = 200, extra = {}, files = 'apps/portal/src/a.ts' }) {
  answer = { status, body: { workflow_runs: runs } };
  requests.length = 0;
  const script = fileURLToPath(new URL('./affected.mjs', import.meta.url));
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [script, '--files', files, '--event', event], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: base,
        GITHUB_REPOSITORY: 'org/repo',
        GITHUB_TOKEN: 'test-token',
        GITHUB_RUN_ID: '99',
        BOS_SKIP_SHA: SHA,
        BOS_SKIP_WORKFLOW: 'ci.yml',
        ...extra,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', fail);
    child.on('close', (code) => {
      const lines = Object.fromEntries(
        out
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      ok({ code, lines, out });
    });
  });
}

test('a push run of the same commit that finished green skips everything, on a push and on a pull request', async () => {
  for (const event of ['push', 'pull_request']) {
    const r = await select({ event, runs: [run({})] });
    assert.equal(r.lines.skip, 'true', event);
    assert.equal(r.lines.full, 'false', event);
    assert.equal(r.lines['qa-matrix'], '{"include":[]}', event);
    assert.equal(r.lines.packages, '', event);
  }
  const url = new URL(requests[0], 'http://x');
  assert.equal(url.pathname, '/repos/org/repo/actions/workflows/ci.yml/runs');
  assert.equal(url.searchParams.get('head_sha'), SHA);
  assert.equal(url.searchParams.get('event'), 'push');
  assert.equal(url.searchParams.get('status'), 'success');
});

for (const [name, runs] of [
  ['failed', [run({ conclusion: 'failure' })]],
  ['cancelled', [run({ conclusion: 'cancelled' })]],
  ['in progress', [run({ status: 'in_progress', conclusion: null })]],
  ['missing', []],
  ['green but from a pull request (affected only)', [run({ event: 'pull_request' })]],
  ['green but for another commit', [run({ head_sha: 'c'.repeat(40) })]],
]) {
  test(`${name}: the push run still runs what the diff selects (a pull request) or everything (a push)`, async () => {
    const pr = await select({ event: 'pull_request', runs });
    assert.equal(pr.lines.skip, 'false');
    assert.equal(pr.lines.portal, 'true');
    assert.equal(pr.lines.full, 'false');
    const push = await select({ event: 'push', runs });
    assert.equal(push.lines.skip, 'false');
    assert.equal(push.lines.full, 'true');
  });
}

test('a scheduled or manual run never skips, even with a green push run of the same commit', async () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const r = await select({ event, runs: [run({})] });
    assert.equal(r.lines.skip, 'false', event);
    assert.equal(r.lines.full, 'true', event);
    assert.equal(requests.length, 0, `${event} does not even ask`);
  }
});

test('an API error, or no token, never skips', async () => {
  const broken = await select({ event: 'push', runs: [run({})], status: 500 });
  assert.equal(broken.lines.skip, 'false');
  assert.equal(broken.lines.full, 'true');
  const noToken = await select({ event: 'push', runs: [run({})], extra: { GITHUB_TOKEN: '' } });
  assert.equal(noToken.lines.skip, 'false');
  assert.equal(requests.length, 0);
});

test('without the skip variables the selector behaves as before', async () => {
  const r = await select({ event: 'push', runs: [run({})], extra: { BOS_SKIP_SHA: '' } });
  assert.equal(r.lines.skip, 'false');
  assert.equal(r.lines.full, 'true');
});
