// --from/--only planning, no-overwrite names, per-workflow state, results history and the
// payment reuse decision. Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { planRuns } from '../lib/plan.mjs';
import { clearSecrets, registerSecret } from '../lib/redact.mjs';
import { finishVideos, saveDriverError, saveResults } from '../lib/runner.mjs';
import {
  acquireLock,
  claimPath,
  LOCK_YOUNG_MS,
  hasEarlierRun,
  placeResult,
  readFolderMeta,
  readState,
  resetWorkflow,
  uniquePath,
  videoBase,
  withFileLock,
  writeJson,
  writeState,
} from '../lib/store.mjs';
import { uniqueValues } from '../lib/config.mjs';
import { emptyStateLocator } from '../lib/session.mjs';
import { contactEmailFor, listIsComplete, paymentDecision } from '../workflows/sales.mjs';

const WF = [
  { name: 'start', stepIds: ['start-1', 'start-2'] },
  { name: 'sales', stepIds: ['sales-1', 'sales-7', 'sales-8'] },
  { name: 'procurement', stepIds: null },
];

const here = path.dirname(fileURLToPath(import.meta.url));
// Above Linux's largest pid (2^22), so never a live process.
const DEAD_PID = 2 ** 22 + 12345;
const tmp = mkdtempSync(path.join(tmpdir(), 'manual-run-selftest-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const freshDir = () => mkdtempSync(path.join(tmp, 'd-'));

describe('--from and --only planning', () => {
  test('a full run plans every workflow', () => {
    assert.deepEqual(
      planRuns(WF, {}).map((p) => p.mode),
      ['full', 'full', 'not-implemented'],
    );
  });

  test('--from applies only to the workflow that has the step', () => {
    const plan = planRuns(WF, { from: 'sales-7' });
    assert.deepEqual(
      plan.map((p) => [p.name, p.mode, p.from]),
      [
        ['start', 'skip', undefined],
        ['sales', 'from', 'sales-7'],
        ['procurement', 'not-implemented', undefined],
      ],
    );
  });

  test('an unknown --from step is refused before anything runs, naming the steps', () => {
    assert.throws(() => planRuns(WF, { from: 'sales-99' }), /sales-99.*sales-1, sales-7/);
    assert.throws(() => planRuns([WF[0]], { from: 'sales-7' }), /not a step/);
    assert.throws(() => planRuns(WF, { from: true }), /needs a step id/);
  });

  test('--only runs just the workflows that hold those steps', () => {
    const plan = planRuns(WF, { only: 'sales-8, start-2' });
    assert.deepEqual(
      plan.map((p) => [p.name, p.mode, p.only]),
      [
        ['start', 'only', ['start-2']],
        ['sales', 'only', ['sales-8']],
        ['procurement', 'skip', undefined],
      ],
    );
    assert.throws(() => planRuns(WF, { only: 'sales-8,nope' }), /--only nope/);
    assert.throws(() => planRuns(WF, { only: ',' }), /--only is empty/);
    assert.throws(() => planRuns(WF, { from: 'sales-7', only: 'sales-8' }), /either/);
  });
});

describe('an empty --from or --only never becomes a full run', () => {
  test('is refused with a clear message', () => {
    for (const from of ['', '  '])
      assert.throws(() => planRuns(WF, { from }), /--from is empty/, JSON.stringify(from));
    for (const only of ['', ' ', ',', ' , '])
      assert.throws(() => planRuns(WF, { only }), /--only is empty/, JSON.stringify(only));
  });
});

describe('no overwrites', () => {
  test('uniquePath counts up instead of replacing a file', () => {
    const dir = mkdtempSync(path.join(tmp, 'u-'));
    const first = uniquePath(dir, 'sales', '.webm');
    assert.equal(path.basename(first), 'sales.webm');
    writeFileSync(first, 'x');
    assert.equal(path.basename(uniquePath(dir, 'sales', '.webm')), 'sales-2.webm');
    writeFileSync(path.join(dir, 'sales-2.webm'), 'x');
    assert.equal(path.basename(uniquePath(dir, 'sales', '.webm')), 'sales-3.webm');
  });

  test('every kind of run has its own video name stem', () => {
    assert.equal(videoBase('sales'), 'sales');
    assert.equal(videoBase('sales', { from: 'sales-7' }), 'sales-from-sales-7');
    assert.equal(
      videoBase('sales', { only: ['sales-3', 'sales-4'] }),
      'sales-only-sales-3_sales-4',
    );
  });

  test('a new run keeps the earlier result under history; saves of one run do not', () => {
    const all = { workflows: {} };
    placeResult(all, 'sales', { runId: 'a', status: 'RUNNING' });
    placeResult(all, 'sales', { runId: 'a', status: 'PASS' });
    assert.equal(all.history, undefined);
    placeResult(all, 'sales', { runId: 'b', status: 'FAIL' });
    assert.deepEqual(all.history.sales, [{ runId: 'a', status: 'PASS' }]);
    assert.equal(all.workflows.sales.runId, 'b');
    // A NOT-IMPLEMENTED placeholder carries nothing worth keeping.
    placeResult(all, 'branches', { status: 'NOT-IMPLEMENTED' });
    placeResult(all, 'branches', { status: 'NOT-IMPLEMENTED' });
    assert.equal(all.history.branches, undefined);
  });

  test('saveResults through results.json: an --only run never erases the full run', () => {
    const outDir = freshDir();
    const cfg = { outDir, label: 'scr1', viewportText: '1440x900', appUrl: 'https://a.localhost' };
    const step = (id, status) => ({
      id,
      title: id,
      status,
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
    });
    const full = {
      name: 'sales',
      title: 't',
      runId: 'r1',
      status: 'PASS',
      wallMs: 1,
      videos: ['/v/sales.webm'],
      steps: [step('sales-1', 'PASS'), step('sales-3', 'PASS')],
    };
    saveResults(cfg, full);
    const partial = {
      name: 'sales',
      title: 't',
      runId: 'r2',
      status: 'PASS',
      wallMs: 1,
      videos: ['/v/sales-only-sales-3.webm'],
      steps: [step('sales-1', 'SKIPPED'), step('sales-3', 'PASS')],
    };
    const merged = saveResults(cfg, partial, full);
    assert.equal(merged.steps[0].status, 'PASS');
    assert.equal(merged.steps[0].fromEarlierRun, true);
    assert.deepEqual(merged.videos, ['/v/sales.webm', '/v/sales-only-sales-3.webm']);
    const saved = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8'));
    assert.equal(saved.history.sales[0].runId, 'r1');
    assert.ok(existsSync(path.join(outDir, 'results.md')));
  });
});

describe('a merged result is green only when every kept step is', () => {
  const cfgFor = () => ({
    outDir: freshDir(),
    label: 'scr1',
    viewportText: '1440x900',
    appUrl: 'https://a.localhost',
  });
  const step = (id, status) => ({
    id,
    title: id,
    status,
    durationMs: 0,
    checks: [],
    findings: [],
    records: {},
  });
  const run = (runId, steps, extra = {}) => ({
    name: 'start',
    title: 't',
    runId,
    status: 'PASS',
    wallMs: 1,
    videos: [],
    steps,
    ...extra,
  });
  // Stopped while start-2 ran: start-2 INTERRUPTED, start-3 never reached.
  const stopped = run('r1', [step('start-1', 'PASS'), step('start-2', 'INTERRUPTED')], {
    status: 'RUNNING',
    interrupted: true,
  });

  test('resuming only start-1 leaves start-2 INTERRUPTED and the workflow not PASS', () => {
    const cfg = cfgFor();
    saveResults(cfg, stopped);
    const merged = saveResults(
      cfg,
      run('r2', [step('start-1', 'PASS'), step('start-2', 'SKIPPED'), step('start-3', 'SKIPPED')]),
      stopped,
    );
    assert.equal(merged.steps[1].status, 'INTERRUPTED');
    assert.equal(merged.status, 'INTERRUPTED');
  });

  test('a segment that reruns the interrupted step can be PASS again', () => {
    const cfg = cfgFor();
    const merged = saveResults(
      cfg,
      run('r2', [step('start-1', 'SKIPPED'), step('start-2', 'PASS'), step('start-3', 'PASS')]),
      stopped,
    );
    assert.equal(merged.status, 'PASS');
  });

  test('a step interrupted two segments ago survives a later checkpoint and keeps the run red', () => {
    const cfg = cfgFor();
    const stored = () =>
      JSON.parse(readFileSync(path.join(cfg.outDir, 'results.json'), 'utf8')).workflows.start;
    const ids = (r) => r.steps.map((st) => `${st.id}:${st.status}`);
    // Full run, stopped while start-3 ran (a checkpoint holds the steps up to the one in flight).
    saveResults(
      cfg,
      run(
        'r1',
        [step('start-1', 'PASS'), step('start-2', 'PASS'), step('start-3', 'INTERRUPTED')],
        {
          status: 'RUNNING',
          interrupted: true,
        },
      ),
    );
    // --only start-1, stopped while start-1 ran: its checkpoint has no entry for start-3.
    saveResults(
      cfg,
      run('r2', [step('start-1', 'INTERRUPTED')], { status: 'RUNNING', interrupted: true }),
      stored(),
    );
    assert.deepEqual(ids(stored()), ['start-1:INTERRUPTED', 'start-2:PASS', 'start-3:INTERRUPTED']);
    // --only start-1 again, to the end: start-3 is still the interrupted one, never SKIPPED/PASS.
    const merged = saveResults(
      cfg,
      run('r3', [
        step('start-1', 'PASS'),
        step('start-2', 'SKIPPED'),
        step('start-3', 'SKIPPED'),
        step('start-4', 'SKIPPED'),
      ]),
      stored(),
    );
    assert.deepEqual(ids(merged), [
      'start-1:PASS',
      'start-2:PASS',
      'start-3:INTERRUPTED',
      'start-4:SKIPPED',
    ]);
    assert.equal(merged.status, 'INTERRUPTED');
    // A FAIL kept from an earlier segment is not overwritten by a SKIPPED either.
    const failed = run('r4', [step('start-1', 'PASS'), step('start-2', 'FAIL')], {
      status: 'FAIL',
    });
    const after = saveResults(cfg, run('r5', [step('start-1', 'INTERRUPTED')]), failed);
    assert.deepEqual(ids(after), ['start-1:INTERRUPTED', 'start-2:FAIL']);
    assert.equal(after.status, 'FAIL');
  });

  test('a video error makes the merged result FAIL even when every step passed', () => {
    const cfg = cfgFor();
    const earlier = run('r1', [step('start-1', 'PASS'), step('start-2', 'PASS')]);
    const merged = saveResults(
      cfg,
      run('r2', [step('start-1', 'SKIPPED'), step('start-2', 'PASS')], {
        status: 'FAIL',
        videoError: 'Videos not finalised: the video of the main window is missing',
      }),
      earlier,
    );
    assert.equal(merged.status, 'FAIL');
    assert.match(readFileSync(path.join(cfg.outDir, 'results.md'), 'utf8'), /video of the main/);
  });

  test('finishVideos reports a missing source video instead of staying silent', async () => {
    const cfg = cfgFor();
    const page = (file) => ({ video: () => ({ path: async () => file }) });
    const kept = path.join(cfg.outDir, 'kept.webm');
    writeFileSync(kept, 'webm');
    const closer = { close: async () => {} };
    const result = { videos: [] };
    // The main window's video is missing: the run fails.
    await assert.rejects(
      finishVideos(
        cfg,
        { videos: [] },
        { ...closer, pages: () => [] },
        { closedPages: [page(path.join(cfg.outDir, 'gone.webm'))] },
        closer,
        'start',
      ),
      /the video of the main window is missing/,
    );
    // A named window's video is missing: the run fails, after the main video is placed.
    await assert.rejects(
      finishVideos(
        cfg,
        result,
        { ...closer, pages: () => [] },
        {
          closedPages: [page(kept)],
          extraContexts: [{ name: 'private', context: closer, pages: [page('/nope.webm')] }],
        },
        closer,
        'start',
      ),
      /the video of the private window is missing/,
    );
    assert.deepEqual(result.videos, [path.join(cfg.outDir, 'start.webm')]);
    // An extra tab without a file (closed before its first frame) is only noted.
    writeFileSync(kept, 'webm');
    const tabs = { videos: [] };
    await finishVideos(
      cfg,
      tabs,
      { ...closer, pages: () => [] },
      { closedPages: [page(kept), page('/nope.webm')] },
      closer,
      'start',
    );
    assert.deepEqual(tabs.videoNotes, ['no video file for tab 2']);
  });

  test('a main window closed before the end is still required: missing or empty fails the run', async () => {
    const cfg = cfgFor();
    const page = (file) => ({ video: () => ({ path: async () => file }) });
    const closer = { close: async () => {} };
    // Playwright removed the closed main page from context.pages(); only another tab is listed.
    const tab = path.join(cfg.outDir, 'tab.webm');
    writeFileSync(tab, 'webm');
    const missing = { videos: [] };
    await assert.rejects(
      finishVideos(
        cfg,
        missing,
        { ...closer, pages: () => [page(tab)] },
        { page: page(path.join(cfg.outDir, 'gone.webm')) },
        closer,
        'start',
      ),
      /the video of the main window is missing/,
    );
    // The tab keeps its own name; the main name is not taken by it.
    assert.deepEqual(missing.videos, [path.join(cfg.outDir, 'start-page2.webm')]);
    assert.ok(!existsSync(path.join(cfg.outDir, 'start.webm')));
    // Nothing listed at all: zero videos is not a success.
    await assert.rejects(
      finishVideos(
        cfg,
        { videos: [] },
        { ...closer, pages: () => [] },
        { page: page(path.join(cfg.outDir, 'gone.webm')) },
        closer,
        'start',
      ),
      /the video of the main window is missing/,
    );
    // An empty main recording fails too.
    const empty = path.join(cfg.outDir, 'empty.webm');
    writeFileSync(empty, '');
    await assert.rejects(
      finishVideos(
        cfg,
        { videos: [] },
        { ...closer, pages: () => [] },
        { page: page(empty) },
        closer,
        'start',
      ),
      /the video of the main window is empty/,
    );
  });
});

describe('claimed names, temp files and the folder lock', () => {
  test('claimPath takes the name: two claims never get the same path', () => {
    const dir = freshDir();
    const a = claimPath(dir, 'sales', '.webm');
    const b = claimPath(dir, 'sales', '.webm');
    assert.equal(path.basename(a), 'sales.webm');
    assert.equal(path.basename(b), 'sales-2.webm');
    assert.ok(existsSync(a) && statSync(a).size === 0, 'claimed as an empty file');
  });

  test('writeJson uses its own temporary file and leaves none behind', () => {
    const dir = freshDir();
    const file = path.join(dir, 'state.json');
    writeJson(file, { a: 1 });
    writeJson(file, { a: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test('one live run per folder; a stale lock is taken over; release removes only its own', () => {
    const dir = freshDir();
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /in use by another manual-run \(pid \d+/);
    release();
    assert.ok(!existsSync(path.join(dir, '.lock')));
    // A lock left by a process that no longer exists (and one from before the hostname was kept).
    writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: DEAD_PID }));
    const again = acquireLock(dir);
    const held = JSON.parse(readFileSync(path.join(dir, '.lock'), 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.equal(held.hostname, hostname());
    // Release removes the lock only while it still carries this run's token.
    writeFileSync(path.join(dir, '.lock'), JSON.stringify({ ...held, token: 'someone else' }));
    again();
    assert.ok(existsSync(path.join(dir, '.lock')));
    assert.deepEqual(
      readdirSync(dir).filter((f) => f !== '.lock'),
      [],
      'no temporary or stale files left',
    );
  });

  test('an empty lock younger than 10 s is held; an old one is stale', () => {
    const dir = freshDir();
    const file = path.join(dir, '.lock');
    writeFileSync(file, '');
    assert.throws(() => acquireLock(dir), /being written right now/);
    const old = new Date(Date.now() - LOCK_YOUNG_MS - 5000);
    utimesSync(file, old, old);
    acquireLock(dir)();
  });

  test('a lock from another machine is held unless --break-lock', () => {
    const dir = freshDir();
    const file = path.join(dir, '.lock');
    writeFileSync(file, JSON.stringify({ pid: DEAD_PID, hostname: 'other-host', startedAt: 'x' }));
    assert.throws(() => acquireLock(dir), /another machine \(other-host.*--break-lock/s);
    const release = acquireLock(dir, { breakLock: true });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
    release();
  });

  /** Starts `n` processes that all try to take the lock of `dir` at the same instant. */
  const race = async (dir, n) => {
    const script = path.join(tmp, 'lock-child.mjs');
    writeFileSync(
      script,
      `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.resolve(here, '../lib/store.mjs')).href)};
const [dir, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
try {
  const release = acquireLock(dir);
  console.log('ok');
  setTimeout(release, 1500);
} catch (e) {
  console.log(/in use by|at the same moment/.test(e.message) ? 'held' : 'error ' + e.message);
}
`,
    );
    const at = Date.now() + 700;
    const outs = await Promise.all(
      Array.from(
        { length: n },
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [script, dir, String(at)]);
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.on('error', reject);
            child.on('close', () => resolve(out.trim()));
          }),
      ),
    );
    return outs;
  };

  test('concurrent acquirers: exactly one wins, on a free folder and on a stale lock', async () => {
    for (let round = 0; round < 3; round++) {
      const dir = freshDir();
      if (round > 0)
        writeFileSync(
          path.join(dir, '.lock'),
          round === 1 ? JSON.stringify({ pid: DEAD_PID, hostname: hostname() }) : '',
        );
      if (round === 2) {
        const old = new Date(Date.now() - LOCK_YOUNG_MS - 5000);
        utimesSync(path.join(dir, '.lock'), old, old);
      }
      const outs = await race(dir, 8);
      assert.equal(outs.filter((o) => o === 'ok').length, 1, `round ${round}: ${outs}`);
      assert.equal(outs.filter((o) => o === 'held').length, 7, `round ${round}: ${outs}`);
    }
  });

  test('the summary lock waits for its holder instead of failing', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'summary.json');
    writeJson(file, []);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withFileLock(dir, '.summary.lock', async () => {
          const prev = JSON.parse(readFileSync(file, 'utf8'));
          await new Promise((r) => setTimeout(r, 5));
          writeJson(file, [...prev, i]);
        }),
      ),
    );
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 8);
  });
});

describe('stopping with a signal', () => {
  /** Runs a child that registers lock, browser and checkpoint callbacks, then signals itself. */
  const stopChild = (body) =>
    new Promise((resolve, reject) => {
      const script = path.join(tmp, `stop-${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(
        script,
        `import { configureCleanup, isStopping, onCleanup } from ${JSON.stringify(pathToFileURL(path.resolve(here, '../lib/cleanup.mjs')).href)};
const say = (t) => process.stdout.write(t + '\\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
${body}
setInterval(() => {}, 1000);
`,
      );
      const child = spawn(process.execPath, [script]);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, lines: out.trim().split('\n') }));
    });

  test('callbacks run newest first, each awaited, the lock last; a quick second signal is ignored', async () => {
    const { code, lines } = await stopChild(`
onCleanup(() => say('lock released'));
onCleanup(async (sync) => { say('browser closing ' + sync); await wait(300); say('browser closed'); });
onCleanup(() => say('checkpoint saved, stopping=' + isStopping()));
setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
setTimeout(() => process.kill(process.pid, 'SIGINT'), 150);
`);
    assert.equal(code, 130);
    assert.deepEqual(lines, [
      'checkpoint saved, stopping=true',
      'browser closing false',
      'browser closed',
      'lock released',
    ]);
  });

  test('a hung callback is cut off, and the forced exit still runs the synchronous rest', async () => {
    const { code, lines } = await stopChild(`
configureCleanup({ taskMs: 5000, forceMs: 300 });
onCleanup((sync) => say('lock released ' + sync));
onCleanup((sync) => (sync ? undefined : new Promise(() => say('browser hangs'))));
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
`);
    assert.equal(code, 143);
    assert.deepEqual(lines, ['browser hangs', 'lock released true']);
  });

  test('each callback gets its own time limit, so a hung one cannot starve the lock release', async () => {
    const { code, lines } = await stopChild(`
configureCleanup({ taskMs: 100, forceMs: 5000 });
onCleanup((sync) => say('lock released ' + sync));
onCleanup(() => new Promise(() => say('browser hangs')));
setTimeout(() => process.kill(process.pid, 'SIGINT'), 50);
`);
    assert.equal(code, 130);
    assert.deepEqual(lines, ['browser hangs', 'lock released false']);
  });
});

describe('a folder belongs to one stack and one run key', () => {
  test('state.json keeps the appUrl and run key it was created with', () => {
    const dir = freshDir();
    const file = path.join(dir, 'state.json');
    assert.deepEqual(readFolderMeta(dir), { appUrl: null, runKey: null, hasRecords: false });
    const meta = { appUrl: 'https://app.a.localhost', runKey: 'x-1440x0900' };
    writeState(file, 'start', { memoUrl: '/memos/1' }, meta);
    writeState(file, 'sales', {}, { appUrl: 'https://app.b.localhost', runKey: 'y' });
    assert.deepEqual(readFolderMeta(dir), { ...meta, hasRecords: true });
  });

  test('a folder from before the meta was stored: appUrl from results.json, no run key', () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ leadUrl: '/leads/1' }));
    writeFileSync(
      path.join(dir, 'results.json'),
      JSON.stringify({ appUrl: 'https://app.old.localhost', workflows: {} }),
    );
    assert.deepEqual(readFolderMeta(dir), {
      appUrl: 'https://app.old.localhost',
      runKey: null,
      hasRecords: true,
    });
  });
});

describe('per-workflow state', () => {
  test('workflows keep separate records; a legacy flat file is read for every workflow', () => {
    const dir = freshDir();
    const file = path.join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ memoUrl: '/memos/1', leadUrl: '/leads/1' }));
    assert.equal(readState(file, 'sales').leadUrl, '/leads/1');
    writeState(file, 'sales', { leadUrl: '/leads/2' });
    assert.equal(readState(file, 'sales').leadUrl, '/leads/2');
    assert.equal(readState(file, 'start').memoUrl, '/memos/1');
  });

  test('an earlier run is detected per workflow, and --fresh clears only that workflow', () => {
    const dir = freshDir();
    assert.equal(hasEarlierRun(dir, 'sales'), false);
    writeState(path.join(dir, 'state.json'), 'start', { memoUrl: '/memos/1' });
    assert.equal(hasEarlierRun(dir, 'start'), true);
    assert.equal(hasEarlierRun(dir, 'sales'), false, 'start ran, sales did not');
    writeState(path.join(dir, 'state.json'), 'sales', { leadUrl: '/leads/1' });
    const backup = resetWorkflow(dir, 'sales');
    assert.ok(backup && existsSync(backup));
    assert.deepEqual(readState(path.join(dir, 'state.json'), 'sales'), {});
    assert.equal(readState(path.join(dir, 'state.json'), 'start').memoUrl, '/memos/1');
  });

  test('a run that could not start does not count as an earlier run', () => {
    const dir = freshDir();
    const cfg = {
      outDir: dir,
      label: 'x',
      viewportText: '1440x900',
      appUrl: 'https://a.localhost',
    };
    saveResults(cfg, {
      name: 'sales',
      title: 't',
      runId: 'r1',
      status: 'FAIL',
      error: 'Could not start: TLS',
      steps: [],
      videos: [],
      wallMs: 0,
    });
    assert.equal(hasEarlierRun(dir, 'sales'), false);
    const step = {
      id: 'sales-1',
      title: 's',
      status: 'FAIL',
      durationMs: 0,
      checks: [],
      findings: [],
      records: {},
    };
    saveResults(cfg, {
      name: 'sales',
      title: 't',
      runId: 'r2',
      status: 'FAIL',
      steps: [step],
      videos: [],
      wallMs: 0,
    });
    assert.equal(hasEarlierRun(dir, 'sales'), true);
  });
});

describe('payments are recorded at most once per run', () => {
  const ref = 'BOS-DEMO-PAY-01-x-1440x0900';
  const ok = (rows) => ({ ok: true, rows });
  test('a recorded URL is reused without a lookup', () => {
    assert.deepEqual(paymentDecision({ recordedUrl: '/payments/a', ref, knownUrls: [] }), {
      action: 'reuse',
      url: '/payments/a',
    });
  });
  test('a failed lookup never counts as "no payment"', () => {
    for (const lookup of [null, undefined, { ok: false, rows: [] }])
      assert.equal(paymentDecision({ lookup, ref, knownUrls: [] }).action, 'fail');
  });
  test('the one payment with exactly this bank reference is adopted', () => {
    assert.deepEqual(
      paymentDecision({
        lookup: ok([
          { url: '/payments/one', ref: 'known' },
          { url: '/payments/two', ref: ` ${ref} ` },
        ]),
        ref,
        knownUrls: ['/payments/one'],
      }),
      { action: 'adopt', url: '/payments/two' },
    );
  });
  test('two payments with this reference fail loudly (possible duplicate)', () => {
    const d = paymentDecision({
      lookup: ok([
        { url: '/payments/a', ref },
        { url: '/payments/b', ref },
      ]),
      ref,
      knownUrls: [],
    });
    assert.equal(d.action, 'fail');
    assert.match(d.reason, /2 payments carry the bank reference/);
  });
  test('a reference that only contains this one is not a match, and stops the step', () => {
    const d = paymentDecision({
      lookup: ok([{ url: '/payments/a', ref: `${ref}0` }]),
      ref,
      knownUrls: [],
    });
    assert.equal(d.action, 'fail');
    assert.match(d.reason, /another bank reference/);
  });
  test('an unreadable reference or a missing known payment fails', () => {
    assert.match(
      paymentDecision({ lookup: ok([{ url: '/payments/a', ref: null }]), ref, knownUrls: [] })
        .reason,
      /could not be read/,
    );
    assert.match(
      paymentDecision({ lookup: ok([]), ref, knownUrls: ['/payments/one'] }).reason,
      /may be incomplete/,
    );
  });
  test('a new payment only after a lookup that loaded and shows none', () => {
    assert.deepEqual(
      paymentDecision({
        lookup: ok([{ url: '/payments/one', ref: 'known' }]),
        ref,
        knownUrls: ['/payments/one'],
      }),
      { action: 'record' },
    );
    assert.deepEqual(paymentDecision({ lookup: ok([]), ref, knownUrls: [] }), {
      action: 'record',
    });
  });

  test("the live app's empty search ('No matching payments.') counts as loaded and empty", () => {
    // A page whose getByText finds the given titles exactly (as Playwright's exact match does).
    const shown = new Set(['No matching payments.']);
    const page = {
      getByText: (title, opts) => ({
        title,
        exact: opts?.exact,
        found: shown.has(title),
        or(other) {
          return {
            ...this,
            title: `${this.title} | ${other.title}`,
            found: this.found || other.found,
            or: this.or,
          };
        },
      }),
    };
    const titles = [
      'No matching payments.',
      'No payments match these filters.',
      'No payments yet.',
    ];
    const loc = emptyStateLocator(page, titles);
    assert.equal(loc.found, true, 'the live title is found');
    assert.equal(loc.exact, true, 'every title is matched exactly');
    assert.equal(loc.title, titles.join(' | '));
    shown.clear();
    shown.add('Try another receipt number or customer name.');
    assert.equal(
      emptyStateLocator(page, titles).found,
      false,
      'the hint alone is not the empty state',
    );
    assert.equal(emptyStateLocator(page, 'No leads match').title, 'No leads match');
    // Zero payments for this run's customer, then: a new payment may be recorded.
    assert.deepEqual(paymentDecision({ lookup: ok([]), ref, knownUrls: [] }), {
      action: 'record',
    });
  });

  test('a payments search that does not fit one page is not searched further', () => {
    assert.deepEqual(listIsComplete({ summary: '2 payments' }), { ok: true });
    assert.deepEqual(listIsComplete({ summary: 'Showing 1–2 of 2 payments' }), { ok: true });
    assert.equal(listIsComplete({ summary: 'x', hasNext: true }).ok, false);
    assert.equal(listIsComplete({ summary: 'Showing 1–5 of 7 payments' }).ok, false);
    assert.equal(listIsComplete({ summary: 'Showing 100 of 1,204 payments' }).ok, false);
    const d = paymentDecision({
      lookup: { ok: false, rows: [], reason: 'the payments search is not one page (next page)' },
      ref,
      knownUrls: [],
    });
    assert.equal(d.action, 'fail');
    assert.match(d.reason, /not one page/);
  });
});

describe('results are saved redacted, and a driver error keeps the saved steps', () => {
  const cfg = (outDir) => ({
    outDir,
    label: 'x',
    viewportText: '1440x900',
    appUrl: 'https://a.localhost',
  });
  const step = (id, extra = {}) => ({
    id,
    title: id,
    status: 'PASS',
    durationMs: 123456,
    checks: [],
    findings: [],
    records: {},
    ...extra,
  });
  after(clearSecrets);

  test('a secret in an error, a check or a finding never reaches results.json or results.md', () => {
    const dir = freshDir();
    registerSecret('Pa55-w0rd"x');
    saveResults(cfg(dir), {
      name: 'start',
      title: 't',
      runId: 'r1',
      status: 'FAIL',
      wallMs: 123456,
      videos: [],
      steps: [
        step('start-6', {
          status: 'FAIL',
          error: 'locator.fill: Timeout | - fill("Pa55-w0rd\\"x")',
          checks: ['typed Pa55-w0rd"x'],
          findings: [{ severity: 'normal', text: 'saw Pa55-w0rd"x' }],
        }),
      ],
    });
    for (const f of ['results.json', 'results.md']) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!text.includes('Pa55-w0rd'), `${f} holds the password`);
      assert.ok(text.includes('[redacted]'), f);
    }
    const saved = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
    assert.equal(saved.workflows.start.steps[0].durationMs, 123456, 'numbers stay numbers');
  });

  test('saveDriverError marks this run FAIL and keeps its steps', () => {
    const dir = freshDir();
    const since = new Date(Date.now() - 1000).toISOString();
    saveResults(cfg(dir), {
      name: 'sales',
      title: 't',
      runId: `${new Date().toISOString()}-${process.pid}`,
      startedAt: new Date().toISOString(),
      status: 'RUNNING',
      wallMs: 1,
      videos: [],
      steps: [step('sales-1'), step('sales-2')],
    });
    const r = saveDriverError(cfg(dir), 'sales', 'Driver error: boom', since);
    assert.equal(r.status, 'FAIL');
    assert.equal(r.error, 'Driver error: boom');
    assert.deepEqual(
      r.steps.map((st) => st.id),
      ['sales-1', 'sales-2'],
    );
    // Without a result of this run, a FAIL without steps is written.
    const other = freshDir();
    assert.deepEqual(saveDriverError(cfg(other), 'sales', 'Driver error: x', since).steps, []);
  });
});

describe('the customer e-mail on a resumed run', () => {
  const u = uniqueValues('fix1-1440');
  const v = {
    email: `${u.emailLocal}@bos-demo.example.com`,
    legacyEmail: `${u.legacyEmailLocal}@bos-demo.example.com`,
  };
  test('a new run uses the current address', () => {
    assert.equal(contactEmailFor({}, v), 'anu.mr-fix1-1440@bos-demo.example.com');
  });
  test('the recorded address wins', () => {
    assert.equal(
      contactEmailFor({ contactEmail: 'a@b.example', opportunityUrl: '/o/1' }, v),
      'a@b.example',
    );
  });
  test('a folder whose customer was created before the address was recorded uses the old form', () => {
    assert.equal(
      contactEmailFor({ opportunityUrl: '/opportunities/1' }, v),
      'anu.scr-fix1-1440@bos-demo.example.com',
    );
  });
});
