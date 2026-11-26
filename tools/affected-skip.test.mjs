// Run: node --test tools/affected-skip.test.mjs
// The same-commit skip is the gate: a wrong skip would let an untested commit pass. These tests run the real selector
// against a local stand-in for the Actions API, with fixtures for every run state it must never skip on.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
let apiBase;
let answer = { status: 200, body: { workflow_runs: [] } };
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  apiBase = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function select({ event, runs, status = 200, extra = {}, files = 'apps/portal/src/a.ts' }) {
  answer = { status, body: { workflow_runs: runs } };
  requests.length = 0;
  const script = fileURLToPath(new URL('./affected.mjs', import.meta.url));
  return new Promise((ok, fail) => {
    const child = spawn(
      process.execPath,
      [
        script,
        '--files',
        files,
        '--event',
        event,
        ...(event === 'pull_request' ? ['--base', 'HEAD', '--head', 'HEAD'] : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_API_URL: apiBase,
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_TOKEN: 'test-token',
          GITHUB_RUN_ID: '99',
          BOS_SKIP_SHA: SHA,
          BOS_SKIP_WORKFLOW: 'ci.yml',
          ...extra,
        },
      },
    );
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

// The workflows pass --base and --head and no --files; a scheduled or manual run has both empty. Run exactly that.
async function selectDiff({ event, base, head, cwd }) {
  answer = { status: 200, body: { workflow_runs: [run({})] } };
  requests.length = 0;
  const dir = cwd ?? mkdtempSync(path.join(tmpdir(), 'affected-skip-'));
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('./affected.mjs', import.meta.url)),
    path.join(dir, 'tools/affected.mjs'),
  );
  const out = await new Promise((ok, fail) => {
    const child = spawn(
      process.execPath,
      [path.join(dir, 'tools/affected.mjs'), '--base', base, '--head', head],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_NAME: event,
          GITHUB_API_URL: apiBase,
          GITHUB_REPOSITORY: 'org/repo',
          GITHUB_TOKEN: 'test-token',
          GITHUB_RUN_ID: '99',
          BOS_SKIP_SHA: SHA,
          BOS_SKIP_WORKFLOW: 'ci.yml',
        },
      },
    );
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('error', fail);
    child.on('close', () => ok(text));
  });
  if (!cwd) rmSync(dir, { recursive: true, force: true });
  return {
    skip: /^skip=(.*)$/m.exec(out)?.[1],
    full: /^full=(.*)$/m.exec(out)?.[1],
    asked: requests.length,
  };
}

test('a scheduled or manual run with an empty --base and --head never skips, the way the workflows call it', async () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const r = await selectDiff({ event, base: '', head: '' });
    assert.deepEqual([r.skip, r.full, r.asked], ['false', 'true', 0], event);
  }
  // A push has no base either, and may skip.
  const push = await selectDiff({ event: 'push', base: '', head: '' });
  assert.deepEqual([push.skip, push.asked], ['true', 1]);
});

test('a pull request skips only when its base is an ancestor of its head, so the merge result is the head itself', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'affected-skip-git-'));
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'one');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(path.join(dir, 'a.txt'), '2');
    git('commit', '-qam', 'two');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'side', base);
    writeFileSync(path.join(dir, 'b.txt'), '3');
    git('add', '.');
    git('commit', '-qm', 'side');
    const diverged = git('rev-parse', 'HEAD');
    const fast = await selectDiff({ event: 'pull_request', base, head, cwd: dir });
    assert.deepEqual([fast.skip, fast.asked], ['true', 1], 'up to date with its base');
    const behind = await selectDiff({
      event: 'pull_request',
      base: head,
      head: diverged,
      cwd: dir,
    });
    assert.deepEqual(
      [behind.skip, behind.asked],
      ['false', 0],
      'the base moved on: the merge is untested',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
